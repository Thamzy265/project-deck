/**
 * Snapshot copies from an Android app's private folder with `adb exec-out run-as`
 * (debuggable apps only). The device's shell joins exec-out arguments into one
 * command line, so every argument is fixed text or a value checked against a strict
 * pattern, and file names go after `--` (design review S7).
 */
import type { AdbRunner } from '@project-deck/android-adb';
import {
  AdbExitError,
  AdbMissingError,
  AdbOutputTooLargeError,
  AdbTimeoutError,
  probeDevices,
  isPackageName,
  isPid,
  isSerial,
  parseDevices,
} from '@project-deck/android-adb';
import type { RunningApp } from '@project-deck/core';
import { ANDROID_APPLICATION_ID, DbError, MAX_DB_DEVICES, isDbError } from '@project-deck/core';
import type { SnapshotSource } from './source.js';
import { ANDROID_FOLDERS, COMPANIONS, SNAPSHOT_FILE, isSnapshotName } from './source.js';

/** Design review S7: `ls` 10 s, `cat` 60 s; `head` reads 100 bytes, so 10 s. */
export const ANDROID_TIMEOUTS = { ls: 10_000, cat: 60_000, head: 10_000 } as const;

const NOT_DEBUGGABLE = /not debuggable/i;
/** head's cap must leave room for a complaint such as "head: …: No such file …". */
const HEAD_ROOM = 4096;
const UNKNOWN_PACKAGE = /unknown package|package .* is unknown/i;
const NO_SUCH_FILE = /no such file/i;

/** A path this source may read: a database name, or one plus a fixed companion suffix. */
function checkedPath(path: string): string {
  const base = COMPANIONS.reduce(
    (p, suffix) => (p.endsWith(suffix) ? p.slice(0, -suffix.length) : p),
    path,
  );
  const folder = base.slice(0, base.lastIndexOf('/'));
  if (!isSnapshotName(base) || !(ANDROID_FOLDERS as readonly string[]).includes(folder)) {
    throw new DbError('not-found', 'No such database in the app.');
  }
  return path;
}

export class AndroidSource implements SnapshotSource {
  readonly label: string;

  constructor(
    private readonly adb: AdbRunner,
    readonly serial: string,
    readonly packageName: string,
  ) {
    if (!isSerial(serial)) throw new Error('Invalid device serial');
    if (!isPackageName(packageName) || !ANDROID_APPLICATION_ID.test(packageName)) {
      throw new Error('Invalid application id');
    }
    this.label = `Android ${serial}`;
  }

  private runAs(...args: string[]): string[] {
    return ['-s', this.serial, 'exec-out', 'run-as', this.packageName, ...args];
  }

  async list(): Promise<string[]> {
    const names: string[] = [];
    for (const folder of ANDROID_FOLDERS) {
      let out: string;
      try {
        out = await this.adb.exec(this.runAs('ls', '-1', folder), {
          timeoutMs: ANDROID_TIMEOUTS.ls,
        });
      } catch (err) {
        if (missingFile(err)) continue;
        throw adbError(err);
      }
      out = stripWarnings(Buffer.from(out, 'utf8')).toString('utf8');
      complain(out);
      for (const line of out.split('\n')) {
        const file = line.replace(/\r$/, '');
        if (SNAPSHOT_FILE.test(file)) names.push(`${folder}/${file}`);
      }
    }
    return names;
  }

  async head(path: string, bytes: number): Promise<Buffer | undefined> {
    const n = Math.trunc(bytes);
    const args = this.runAs('head', '-c', String(n), '--', checkedPath(path));
    const isDb = isSnapshotName(path);
    // Room for the device's complaint, which exec-out mixes into stdout (R2); only the
    // bytes asked for are returned.
    const out = await this.binary(args, {
      timeoutMs: ANDROID_TIMEOUTS.head,
      maxBytes: Math.max(n, HEAD_ROOM),
    });
    if (out !== undefined && isDb) extraText(out);
    return out?.subarray(0, n);
  }

  async read(path: string, maxBytes: number): Promise<Buffer | undefined> {
    const args = this.runAs('cat', '--', checkedPath(path));
    const out = await this.binary(args, { timeoutMs: ANDROID_TIMEOUTS.cat, maxBytes });
    if (out !== undefined && isSnapshotName(path)) extraText(out);
    return out;
  }

  private async binary(
    args: string[],
    opts: { timeoutMs: number; maxBytes: number },
  ): Promise<Buffer | undefined> {
    let out: Buffer;
    try {
      out = stripWarnings(await this.adb.execBinary(args, opts));
    } catch (err) {
      if (missingFile(err)) return undefined;
      throw adbError(err);
    }
    // exec-out has no shell protocol: the device's stderr comes back inside stdout and
    // adb exits 0. A SQLite file starts with "SQLite format 3", a WAL with its binary
    // magic and a hot journal with its own, so none of them starts with these words.
    // Anything else that does is not a file the backend could use (the header and WAL
    // checks would refuse it), so treating it as the device's complaint loses nothing.
    const start = out.subarray(0, 200).toString('latin1');
    if (/^(cat|head): /.test(start)) {
      if (NO_SUCH_FILE.test(start)) return undefined;
      throw new DbError('unavailable', "Couldn't read the database: the device refused.");
    }
    complain(start);
    return out;
  }
}

const WARNING = Buffer.from('WARNING: ');
/** Most warning lines skipped; more than this is not a warning preamble. */
const MAX_WARNINGS = 16;

/**
 * Drops `WARNING: …` lines the device printed before the command's own output: the
 * old linker on API 24/25 prints one ("unused DT entry") before every command (L2).
 */
export function stripWarnings(out: Buffer): Buffer {
  let rest = out;
  for (let i = 0; i < MAX_WARNINGS && rest.subarray(0, WARNING.length).equals(WARNING); i++) {
    const end = rest.subarray(0, 4096).indexOf(0x0a);
    if (end === -1) break;
    rest = rest.subarray(end + 1);
  }
  return rest;
}

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

/**
 * A database file that doesn't start with SQLite's header but with readable text: the
 * device printed something first that isn't a known warning (L2). Said as such, rather
 * than "not a SQLite database", so the user looks at the device.
 */
function extraText(out: Buffer): void {
  const start = out.subarray(0, 32);
  if (start.length === 0 || SQLITE_MAGIC.equals(out.subarray(0, 16))) return;
  const text = start.every(
    (b) => (b >= 0x20 && b < 0x7f) || b === 0x0a || b === 0x0d || b === 0x09,
  );
  if (text) {
    throw new DbError(
      'unavailable',
      "Couldn't read the database: the device printed extra text before it.",
    );
  }
}

/** Throws for run-as's refusals, wherever they were printed. */
function complain(text: string): void {
  if (!text.startsWith('run-as:')) return;
  if (NOT_DEBUGGABLE.test(text)) throw notDebuggable();
  if (UNKNOWN_PACKAGE.test(text)) {
    throw new DbError('unavailable', "The app isn't installed on this device.");
  }
  throw new DbError('unavailable', "Couldn't read the database: run-as refused.");
}

function notDebuggable(): DbError {
  return new DbError(
    'not-debuggable',
    "This app isn't debuggable, so Android won't let FlutterDeck copy its database.",
  );
}

function missingFile(err: unknown): boolean {
  return (
    err instanceof AdbExitError &&
    NO_SUCH_FILE.test(err.stderr) &&
    !err.stderr.startsWith('run-as:')
  );
}

/** An adb failure in FlutterDeck's words: device output is never repeated. */
function adbError(err: unknown): DbError {
  if (isDbError(err)) return err;
  if (err instanceof AdbExitError) {
    complain(err.stderr);
    return new DbError('unavailable', "Couldn't read the database: adb failed.");
  }
  if (err instanceof AdbTimeoutError) {
    return new DbError('unavailable', "Couldn't read the database: adb didn't answer.");
  }
  if (err instanceof AdbOutputTooLargeError) {
    return new DbError('too-large', 'The database is over 50 MB, too large to copy.');
  }
  if (err instanceof AdbMissingError) {
    return new DbError('unavailable', 'adb was not found. Install the Android SDK platform tools.');
  }
  return new DbError('unavailable', "Couldn't read the database: adb failed.");
}

const chooseDevice = (serials: readonly string[]): DbError =>
  new DbError(
    'choose-device',
    'More than one Android device could be running this app. Pick the one to copy from.',
    { devices: serials.slice(0, MAX_DB_DEVICES).map((serial) => ({ id: serial, name: serial })) },
  );

/**
 * The device and package for an attached Android app. Pids repeat across devices, so
 * a device counts only when the process at the app's pid is the app: its id from
 * `android.applicationId` or a package-shaped app name. Without either, the one device
 * that runs any package at that pid (its process name is the id, flavor suffix
 * included). When more than one device is still possible the user must pick:
 * FlutterDeck never guesses which device to copy from.
 */
export async function resolveAndroidSource(
  adb: AdbRunner,
  app: RunningApp,
  configuredId: string | undefined,
  /** The serial the user picked after a `choose-device` answer; used only if still listed. */
  chosen?: string,
): Promise<AndroidSource> {
  try {
    if (app.pid !== undefined && isPid(app.pid)) {
      const devices = await probeDevices(adb, app.pid);
      const wanted = new Set(
        [configuredId, app.name].filter(
          (id): id is string => id !== undefined && isPackageName(id),
        ),
      );
      const running = devices.filter((d) => isPackageName(d.process));
      const matches = wanted.size > 0 ? running.filter((d) => wanted.has(d.process)) : running;
      const picked = matches.find((d) => d.serial === chosen);
      if (picked !== undefined) return new AndroidSource(adb, picked.serial, picked.process);
      if (matches.length > 1) throw chooseDevice(matches.map((d) => d.serial));
      const [match] = matches;
      if (match !== undefined) return new AndroidSource(adb, match.serial, match.process);
      // ps can't name the process (old devices): only one device leaves no doubt.
      const [only] = devices;
      if (devices.length === 1 && only?.process === '' && configuredId !== undefined) {
        return new AndroidSource(adb, only.serial, configuredId);
      }
      if (wanted.size === 0 && running.length === 0) throw missingId();
      // On the picked device the process at the pid must be this app: one of its ids or
      // a flavor of one (`<id>.<suffix>`). Pids repeat across devices, so it may be
      // another debuggable app, whose database must never be copied (review R2).
      const device = devices.find((d) => d.serial === chosen);
      if (device !== undefined && devices.length > 1) {
        if (device.process === '' && configuredId !== undefined) {
          return new AndroidSource(adb, device.serial, configuredId);
        }
        const id = appIdOf(device.process, wanted);
        if (id === undefined) {
          throw new DbError(
            'unavailable',
            `The app running on ${device.serial} isn't this app, so FlutterDeck won't copy its database. Set android.applicationId in .flutterdeck/config.json if this is a flavor of it.`,
          );
        }
        return new AndroidSource(adb, device.serial, id);
      }
      if (devices.length > 1) throw chooseDevice(devices.map((d) => d.serial));
      if (devices.length === 1) {
        throw new DbError(
          'unavailable',
          "FlutterDeck couldn't find this app on the device. Set android.applicationId in .flutterdeck/config.json.",
        );
      }
    }
    if (configuredId === undefined) throw missingId();
    const serials = parseDevices(await adb.exec(['devices']));
    const [only] = serials;
    if (only === undefined) {
      throw new DbError('unavailable', 'No Android device is connected.');
    }
    if (chosen !== undefined && serials.includes(chosen)) {
      return new AndroidSource(adb, chosen, configuredId);
    }
    if (serials.length > 1) throw chooseDevice(serials);
    return new AndroidSource(adb, only, configuredId);
  } catch (err) {
    throw adbError(err);
  }
}

/**
 * The package of `process` (without a `:remote`-style process suffix) when it is one of
 * the `wanted` ids or a flavor of one; undefined otherwise.
 */
function appIdOf(process: string, wanted: ReadonlySet<string>): string | undefined {
  const pkg = process.split(':')[0] ?? '';
  if (!isPackageName(pkg)) return undefined;
  for (const id of wanted) if (pkg === id || pkg.startsWith(`${id}.`)) return pkg;
  return undefined;
}

function missingId(): DbError {
  return new DbError(
    'unavailable',
    "FlutterDeck couldn't tell this app's id. Set android.applicationId in .flutterdeck/config.json.",
  );
}
