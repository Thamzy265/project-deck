import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { isLoopbackWsUri } from './json-rpc.js';

export interface DtdInfo {
  wsUri: string;
  pid?: number;
  ideName?: string;
  dartVersion?: string;
  source: 'pid-file' | 'dart-cli' | 'manual';
}

/** Where Dart 3.12+ keeps per-user state, including DTD pid files (`<home>/dtd/<pid>`). */
export function dartDataHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.DART_DATA_HOME) return env.DART_DATA_HOME;
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Dart');
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Dart');
  return join(env.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'Dart');
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const PidFileSchema = z.object({
  wsUri: z.string(),
  pid: z.number().int().positive(),
  dartVersion: z.string().optional(),
  ideName: z.string().optional(),
});

/**
 * Reads DTD pid files, skipping ones whose process is gone (they are never
 * cleaned up on crash) and any that point somewhere other than loopback.
 * Resolves to undefined when the directory doesn't exist (older SDK).
 */
export async function readPidFiles(
  dataHome: string,
  isAlive: (pid: number) => boolean = isProcessAlive,
): Promise<DtdInfo[] | undefined> {
  const dir = join(dataHome, 'dtd');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  const out: DtdInfo[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const parsed = PidFileSchema.safeParse(JSON.parse(await readFile(join(dir, name), 'utf8')));
      if (!parsed.success) continue;
      const info = parsed.data;
      if (!isLoopbackWsUri(info.wsUri) || !isAlive(info.pid)) continue;
      out.push({
        wsUri: info.wsUri,
        pid: info.pid,
        source: 'pid-file',
        ...(info.ideName === undefined ? {} : { ideName: info.ideName }),
        ...(info.dartVersion === undefined ? {} : { dartVersion: info.dartVersion }),
      });
    } catch {
      // A file being written or deleted while we read it; the next scan will see it.
    }
  }
  return out;
}

/** One entry of `dart tooling-daemon --list --machine`: the same fields as a pid file. */
const CliEntrySchema = z.object({
  wsUri: z.string(),
  pid: z.number().int().positive().optional(),
  ideName: z.string().optional(),
  dartVersion: z.string().optional(),
});

export type ExecFn = (file: string, args: string[]) => Promise<string>;

const defaultExec: ExecFn = (file, args) =>
  new Promise((resolve, reject) => {
    // `dart` is a .bat on Windows, which can only be started through a shell.
    // The arguments are fixed constants, so there is nothing to inject. cmd.exe
    // looks in the current directory before PATH, so run from the home directory
    // rather than wherever the daemon was started: a `dart.bat` planted in a
    // cloned project must not run in place of the SDK.
    execFile(
      file,
      args,
      { timeout: 5000, windowsHide: true, shell: process.platform === 'win32', cwd: homedir() },
      (err, stdout) => {
        if (err) reject(new Error(err.message, { cause: err }));
        else resolve(stdout);
      },
    );
  });

/**
 * Fallback for setups where we can't find the pid-file directory:
 * `dart tooling-daemon --list --machine`. Checked against Dart 3.12.2, which prints a JSON
 * array of `{wsUri, epoch, pid, dartVersion, workspaceRoot, ideName}` (see the tests).
 */
export async function listViaDartCli(exec: ExecFn = defaultExec): Promise<DtdInfo[]> {
  let stdout: string;
  try {
    stdout = await exec('dart', ['tooling-daemon', '--list', '--machine']);
  } catch {
    return [];
  }
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: DtdInfo[] = [];
  // Entry by entry, so one odd entry doesn't hide the others.
  for (const item of raw) {
    const parsed = CliEntrySchema.safeParse(item);
    if (!parsed.success) continue;
    const e = parsed.data;
    if (!isLoopbackWsUri(e.wsUri)) continue;
    out.push({
      wsUri: e.wsUri,
      source: 'dart-cli',
      ...(e.pid === undefined ? {} : { pid: e.pid }),
      ...(e.ideName === undefined ? {} : { ideName: e.ideName }),
      ...(e.dartVersion === undefined ? {} : { dartVersion: e.dartVersion }),
    });
  }
  return out;
}

/**
 * Turns an http VM service address (as printed by `flutter run`) into its WebSocket form.
 * Returns undefined for anything unparseable: these come from DTDs and users, not from us.
 */
export function toVmServiceWsUri(uri: string): string | undefined {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return undefined;
  }
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/ws') ? path : `${path}/ws`;
  return url.toString();
}
