/**
 * Snapshot copies from an app on a booted iOS simulator (PM decision D4 B, 16 Oct
 * 2026). The container is a folder on this Mac, found with
 * `/usr/bin/xcrun simctl get_app_container <udid> <bundleId> data`; files are read
 * straight from it without following any link (design review S7).
 */
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import type { RunningApp } from '@project-deck/core';
import { killHard } from '@project-deck/android-adb';
import { DbError, IOS_BUNDLE_ID } from '@project-deck/core';
import { z } from 'zod';
import type { SnapshotSource } from './source.js';
import { COMPANIONS, IOS_FOLDERS, SNAPSHOT_FILE, isSnapshotName } from './source.js';

/** The only xcrun the daemon runs: by absolute path, never from the PATH. */
export const XCRUN_PATH = '/usr/bin/xcrun';
/** Design review S7: `simctl list` 10 s, `get_app_container` 10 s. */
export const IOS_TIMEOUTS = { list: 10_000, container: 10_000 } as const;
const UDID = /^[0-9A-F-]{36}$/;
const MAX_OUTPUT = 1024 * 1024;

export interface XcrunRunner {
  /** Runs xcrun with these arguments and resolves to its stdout. */
  exec(args: readonly string[], timeoutMs: number): Promise<string>;
}

/** Runs xcrun with spawn, never a shell, from the home folder, killed on its timeout. */
export function nodeXcrun(path: string = XCRUN_PATH): XcrunRunner {
  return {
    exec(args, timeoutMs) {
      return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let failure: Error | undefined;
        const child = spawn(path, args, {
          shell: false,
          windowsHide: true,
          cwd: homedir(),
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        // Rejects at once; an xcrun that ignores SIGTERM gets SIGKILL after a grace.
        const stop = (err: Error): void => {
          if (failure !== undefined) return;
          failure = err;
          clearTimeout(timer);
          reject(err);
          killHard(child);
        };
        const timer = setTimeout(() => stop(new Error("xcrun didn't answer")), timeoutMs);
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(failure ?? err);
        });
        child.stdout.on('error', (err) => stop(err));
        child.stdout.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_OUTPUT) stop(new Error('xcrun printed too much'));
          else chunks.push(chunk);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (failure !== undefined) reject(failure);
          else if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
          else reject(new Error(`xcrun exited with code ${code ?? '?'}`));
        });
      });
    },
  };
}

const SimctlList = z.object({
  devices: z.record(
    z.string(),
    z.array(z.object({ udid: z.string(), state: z.string(), name: z.string().max(200) }).loose()),
  ),
});

/** Every path part below the container must be a real folder or file, never a link. */
async function noLinks(
  containerReal: string,
  parts: string[],
  last: 'file' | 'dir',
): Promise<string> {
  let at = containerReal;
  for (const [i, part] of parts.entries()) {
    at = join(at, part);
    const info = await lstat(at);
    const wantFile = last === 'file' && i === parts.length - 1;
    if (info.isSymbolicLink() || (wantFile ? !info.isFile() : !info.isDirectory())) {
      throw new DbError('not-found', 'No such database in the app.');
    }
  }
  return at;
}

export class IosSimulatorSource implements SnapshotSource {
  readonly label: string;

  constructor(
    /** The container's real path, already checked to be inside the simulators folder. */
    private readonly containerReal: string,
    simulatorName: string,
  ) {
    // eslint-disable-next-line no-control-regex
    this.label = `iOS simulator ${simulatorName.replace(/[\u0000-\u001f\u007f]/g, ' ')}`;
  }

  async list(): Promise<string[]> {
    const names: string[] = [];
    for (const folder of IOS_FOLDERS) {
      let dir: string;
      try {
        dir = await noLinks(this.containerReal, folder.split('/'), 'dir');
      } catch {
        continue;
      }
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isFile() && SNAPSHOT_FILE.test(entry.name)) names.push(`${folder}/${entry.name}`);
      }
    }
    return names.sort();
  }

  head(path: string, bytes: number): Promise<Buffer | undefined> {
    return this.readFile(path, bytes, true);
  }

  read(path: string, maxBytes: number): Promise<Buffer | undefined> {
    return this.readFile(path, maxBytes, false);
  }

  private async readFile(path: string, limit: number, head: boolean): Promise<Buffer | undefined> {
    const base = COMPANIONS.reduce(
      (p, suffix) => (p.endsWith(suffix) ? p.slice(0, -suffix.length) : p),
      path,
    );
    const folder = base.slice(0, base.lastIndexOf('/'));
    if (!isSnapshotName(base) || !(IOS_FOLDERS as readonly string[]).includes(folder)) {
      throw new DbError('not-found', 'No such database in the app.');
    }
    let file: string;
    try {
      file = await noLinks(this.containerReal, path.split('/'), 'file');
    } catch (err) {
      if (err instanceof DbError) throw err;
      return undefined;
    }
    // O_NOFOLLOW: a link swapped in after the check above is refused, not followed.
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
      () => undefined,
    );
    if (handle === undefined) return undefined;
    try {
      const info = await handle.stat();
      if (!info.isFile()) return undefined;
      // lstat can't see a hard link, but the link count can: an app could hard-link
      // another file of the user's into its container.
      if (info.nlink !== 1) throw new DbError('not-found', 'No such database in the app.');
      if (!head && info.size > limit) {
        throw new DbError('too-large', 'The database is over 50 MB, too large to copy.');
      }
      const size = head ? Math.min(limit, info.size) : info.size;
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, 0);
      if ((await realpath(file)) !== file)
        throw new DbError('not-found', 'No such database in the app.');
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
}

export interface IosResolveOptions {
  /** Defaults to ~/Library/Developer/CoreSimulator/Devices. */
  simulatorRoot?: string;
  platform?: NodeJS.Platform;
}

/**
 * The container of the app on a booted simulator. Only booted simulators count, never
 * a physical device. With more than one booted simulator that has the app the user
 * must pick, unless the app's own device id names one: FlutterDeck never guesses.
 */
export async function resolveIosSource(
  xcrun: XcrunRunner,
  app: RunningApp,
  bundleId: string | undefined,
  opts: IosResolveOptions = {},
): Promise<IosSimulatorSource> {
  if ((opts.platform ?? process.platform) !== 'darwin') {
    throw new DbError('unsupported', 'iOS simulator snapshots need macOS.');
  }
  if (bundleId === undefined || !IOS_BUNDLE_ID.test(bundleId) || bundleId.length > 155) {
    throw new DbError(
      'unavailable',
      "FlutterDeck doesn't know this app's bundle id. Set ios.bundleId in .flutterdeck/config.json.",
    );
  }
  let listed: z.infer<typeof SimctlList>;
  try {
    listed = SimctlList.parse(
      JSON.parse(
        await xcrun.exec(['simctl', 'list', 'devices', 'booted', '-j'], IOS_TIMEOUTS.list),
      ),
    );
  } catch {
    throw new DbError(
      'unavailable',
      "Couldn't read the database: xcrun simctl list didn't answer.",
    );
  }
  const booted = Object.values(listed.devices)
    .flat()
    .filter((d) => d.state === 'Booted' && UDID.test(d.udid));
  // Which simulator runs the app. connector-dart knows the device only by the name
  // Flutter shows (its id is 'unknown'), so a known UDID wins, then the name. An app
  // whose device matches no booted simulator runs on a physical iPhone: never read a
  // simulator's copy of the same app instead (R5).
  if (booted.length === 0) throw new DbError('unavailable', 'No iOS simulator is booted.');
  const deviceId = app.device?.id;
  const deviceName = app.device?.name;
  const knownId = deviceId !== undefined && UDID.test(deviceId) ? deviceId : undefined;
  const byId = knownId === undefined ? undefined : booted.filter((d) => d.udid === knownId);
  const byName =
    deviceName === undefined || deviceName === ''
      ? undefined
      : booted.filter((d) => d.name === deviceName);
  const idSaysDevice =
    deviceId !== undefined && deviceId !== '' && deviceId !== 'unknown' && knownId === undefined;
  const candidates = byId !== undefined && byId.length > 0 ? byId : (byName ?? booted);
  if (
    idSaysDevice ||
    (byId !== undefined && byId.length === 0 && byName === undefined) ||
    candidates.length === 0
  ) {
    throw new DbError('unavailable', 'Snapshots work on the iOS simulator only.');
  }
  const withApp: { udid: string; name: string; container: string }[] = [];
  for (const sim of candidates) {
    const out = await xcrun
      .exec(['simctl', 'get_app_container', sim.udid, bundleId, 'data'], IOS_TIMEOUTS.container)
      .catch(() => undefined);
    const container = out?.trim();
    if (container !== undefined && container !== '' && !container.includes('\n')) {
      withApp.push({ udid: sim.udid, name: sim.name, container });
    }
  }
  const [chosen] = withApp;
  if (withApp.length > 1) {
    throw new DbError(
      'choose-device',
      'The app is on more than one booted iOS simulator. Shut down the others to take a snapshot.',
    );
  }
  if (chosen === undefined) {
    throw new DbError('unavailable', "The app isn't installed on a booted iOS simulator.");
  }
  const root = opts.simulatorRoot ?? join(homedir(), 'Library/Developer/CoreSimulator/Devices');
  let containerReal: string;
  let rootReal: string;
  try {
    if (!isAbsolute(chosen.container)) throw new Error('relative');
    [containerReal, rootReal] = await Promise.all([realpath(chosen.container), realpath(root)]);
  } catch {
    throw new DbError('unavailable', "Couldn't find the app's folder on the simulator.");
  }
  if (!containerReal.startsWith(rootReal + sep)) {
    throw new DbError('unavailable', "The app's folder isn't inside the simulators folder.");
  }
  return new IosSimulatorSource(containerReal, chosen.name);
}
