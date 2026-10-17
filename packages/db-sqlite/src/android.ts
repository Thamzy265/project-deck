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
  findDeviceForPid,
  isPackageName,
  isPid,
  isSerial,
  parseDevices,
} from '@project-deck/android-adb';
import type { RunningApp } from '@project-deck/core';
import { ANDROID_APPLICATION_ID, DbError, isDbError } from '@project-deck/core';
import type { SnapshotSource } from './source.js';
import { ANDROID_FOLDERS, COMPANIONS, SNAPSHOT_FILE, isSnapshotName } from './source.js';

/** Design review S7: `ls` 10 s, `cat` 60 s; `head` reads 100 bytes, so 10 s. */
export const ANDROID_TIMEOUTS = { ls: 10_000, cat: 60_000, head: 10_000 } as const;

const NOT_DEBUGGABLE = /not debuggable/i;
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
      complain(out);
      for (const line of out.split('\n')) {
        const file = line.replace(/\r$/, '');
        if (SNAPSHOT_FILE.test(file)) names.push(`${folder}/${file}`);
      }
    }
    return names;
  }

  async head(path: string, bytes: number): Promise<Buffer | undefined> {
    const args = this.runAs('head', '-c', String(Math.trunc(bytes)), '--', checkedPath(path));
    return this.binary(args, { timeoutMs: ANDROID_TIMEOUTS.head, maxBytes: bytes });
  }

  async read(path: string, maxBytes: number): Promise<Buffer | undefined> {
    const args = this.runAs('cat', '--', checkedPath(path));
    return this.binary(args, { timeoutMs: ANDROID_TIMEOUTS.cat, maxBytes });
  }

  private async binary(
    args: string[],
    opts: { timeoutMs: number; maxBytes: number },
  ): Promise<Buffer | undefined> {
    let out: Buffer;
    try {
      out = await this.adb.execBinary(args, opts);
    } catch (err) {
      if (missingFile(err)) return undefined;
      throw adbError(err);
    }
    // exec-out without the shell protocol puts the device's complaints on stdout and
    // exits 0. A database (or its WAL or journal) never starts with this text.
    const start = out.subarray(0, 200).toString('latin1');
    if (/^(cat|head): /.test(start) && NO_SUCH_FILE.test(start)) return undefined;
    complain(start);
    return out;
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

/**
 * The device and package for an attached Android app. The device is the one whose
 * process at the app's pid is a package (the running app tells us its own id, which
 * also covers flavors with an id suffix); `android.applicationId` from config.json is
 * the fallback. With several possible devices the user must pick: FlutterDeck never
 * guesses which device to copy from.
 */
export async function resolveAndroidSource(
  adb: AdbRunner,
  app: RunningApp,
  configuredId: string | undefined,
): Promise<AndroidSource> {
  try {
    if (app.pid !== undefined && isPid(app.pid)) {
      const device = await findDeviceForPid(adb, app.pid, app.name);
      if (device !== undefined) {
        const pkg = isPackageName(device.process) ? device.process : configuredId;
        if (pkg === undefined) throw missingId();
        return new AndroidSource(adb, device.serial, pkg);
      }
    }
    if (configuredId === undefined) throw missingId();
    const serials = parseDevices(await adb.exec(['devices']));
    const [only] = serials;
    if (only === undefined) {
      throw new DbError('unavailable', 'No Android device is connected.');
    }
    if (serials.length > 1) {
      throw new DbError(
        'choose-device',
        'More than one Android device is connected. Disconnect the others to take a snapshot.',
      );
    }
    return new AndroidSource(adb, only, configuredId);
  } catch (err) {
    throw adbError(err);
  }
}

function missingId(): DbError {
  return new DbError(
    'unavailable',
    "FlutterDeck couldn't tell this app's id. Set android.applicationId in .flutterdeck/config.json.",
  );
}
