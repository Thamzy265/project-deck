import { execFile, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';

/** adb itself is not installed or not where we looked. */
export class AdbMissingError extends Error {
  constructor(readonly path: string) {
    super(`adb was not found (looked for '${path}')`);
  }
}

/** A streaming adb command ended on its own with a failure exit. */
export class AdbExitError extends Error {
  constructor(
    readonly code: number | null,
    readonly signal: string | null,
  ) {
    super(`adb exited with ${code === null ? `signal ${signal ?? '?'}` : `code ${code}`}`);
  }
}

export interface AdbStream {
  /** Stops the adb client process. The app on the device is not affected. */
  kill(): void;
}

export interface AdbStreamHandlers {
  onData(text: string): void;
  /** Called once. Undefined when the stream ended normally or was killed by us. */
  onExit(err: Error | undefined): void;
}

/**
 * The only way this package runs adb. Arguments go straight to the process with
 * no shell; callers validate every value they put in them.
 */
export interface AdbRunner {
  /** Runs a short adb command and resolves to its stdout. */
  exec(args: readonly string[]): Promise<string>;
  /** Starts a long-running adb command, such as logcat. */
  stream(args: readonly string[], handlers: AdbStreamHandlers): AdbStream;
}

const SERIAL = /^[A-Za-z0-9._:-]{1,64}$/;
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

/** A serial we are willing to pass to `adb -s`. */
export function isSerial(value: string): boolean {
  return SERIAL.test(value) && !value.startsWith('-');
}

export function isPid(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function isPackageName(value: string): boolean {
  return PACKAGE.test(value);
}

/** Serials of devices that are online (`device` state) in `adb devices` output. */
export function parseDevices(output: string): string[] {
  const serials: string[] = [];
  for (const raw of output.split('\n')) {
    const m = /^(\S+)\tdevice$/.exec(raw.replace(/\r+$/, ''));
    const serial = m?.[1];
    if (serial !== undefined && isSerial(serial)) serials.push(serial);
  }
  return serials;
}

/**
 * The process name in `ps` output for `pid`, or '' when there is none. Toybox
 * (`ps -o NAME= -p <pid>`, API 26+) prints just the name; old toolbox (`ps <pid>`)
 * prints a header and rows with NAME as the last column.
 */
export function parsePsName(output: string, pid: number): string {
  const lines = output
    .split('\n')
    .map((l) => l.replace(/\r+$/, '').trim())
    .filter((l) => l !== '');
  const [first, ...rows] = lines;
  if (first === undefined) return '';
  const columns = first.split(/\s+/);
  const pidColumn = columns.indexOf('PID');
  if (pidColumn === -1 || columns.at(-1) !== 'NAME') return first;
  for (const row of rows) {
    const cells = row.split(/\s+/);
    if (cells[pidColumn] === String(pid)) return cells.at(-1) ?? '';
  }
  return '';
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Absolute path of adb, or undefined when it isn't installed. Android Studio installs it
 * in the SDK without adding it to the PATH, so look in the SDK first, then walk the PATH
 * ourselves. Only absolute PATH entries count: a bare `adb` could otherwise run a file
 * from the current directory (Windows searches it first).
 */
export function resolveAdbPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  exists: (path: string) => boolean = isFile,
): string | undefined {
  const win = platform === 'win32';
  const exe = win ? 'adb.exe' : 'adb';
  // A relative directory would resolve against the cwd, so every source must be absolute.
  const absolute = (dir: string | undefined): dir is string =>
    dir !== undefined && (win ? win32.isAbsolute(dir) : posix.isAbsolute(dir));
  const sdks: (string | undefined)[] = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT];
  if (platform === 'darwin') sdks.push(join(home, 'Library', 'Android', 'sdk'));
  else if (win) {
    if (absolute(env.LOCALAPPDATA)) sdks.push(join(env.LOCALAPPDATA, 'Android', 'Sdk'));
  } else sdks.push(join(home, 'Android', 'Sdk'));
  const dirs = [
    ...sdks.filter(absolute).map((sdk) => join(sdk, 'platform-tools')),
    ...(env.PATH ?? env.Path ?? '').split(win ? ';' : ':').filter(absolute),
  ];
  const candidates = dirs.map((dir) => join(dir, exe));
  return candidates.find((candidate) => exists(candidate));
}

export interface NodeAdbOptions {
  /** For short commands. A device that stops answering must not hang an attach. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_EXEC_OUTPUT = 1024 * 1024;

function isNotFound(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

/**
 * Runs the real adb binary at `path` with execFile/spawn, never a shell, from the home
 * directory. `null` means adb wasn't found: every call then fails with AdbMissingError.
 */
export function nodeAdb(
  path: string | null = resolveAdbPath() ?? null,
  opts: NodeAdbOptions = {},
): AdbRunner {
  if (path === null) return missingAdb();
  return {
    exec(args) {
      return new Promise((resolve, reject) => {
        const child = execFile(
          path,
          args,
          {
            shell: false,
            windowsHide: true,
            cwd: homedir(),
            encoding: 'utf8',
            timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxBuffer: MAX_EXEC_OUTPUT,
          },
          (err, stdout) => {
            if (err === null) resolve(stdout);
            else if (isNotFound(err)) reject(new AdbMissingError(path));
            else reject(err instanceof Error ? err : new Error(err.message));
          },
        );
        // execFile's callback already reports spawn errors; this keeps an emitter error from ever being unhandled.
        child.on('error', () => undefined);
      });
    },

    stream(args, handlers) {
      let killed = false;
      let done = false;
      const finish = (err: Error | undefined): void => {
        if (done) return;
        done = true;
        handlers.onExit(err);
      };
      const child = spawn(path, args, {
        shell: false,
        windowsHide: true,
        cwd: homedir(),
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      child.on('error', (err) => finish(isNotFound(err) ? new AdbMissingError(path) : err));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (text: string) => handlers.onData(text));
      child.stdout.on('error', (err) => finish(err));
      child.on('close', (code, signal) => {
        if (killed || code === 0) finish(undefined);
        else finish(new AdbExitError(code, signal));
      });
      return {
        kill() {
          if (killed || done) return;
          killed = true;
          child.kill();
        },
      };
    },
  };
}

function missingAdb(): AdbRunner {
  return {
    exec: () => Promise.reject(new AdbMissingError('adb')),
    stream(_args, handlers) {
      // Asynchronous like a failed spawn, so callers can finish setting up first.
      setImmediate(() => handlers.onExit(new AdbMissingError('adb')));
      return { kill: () => undefined };
    },
  };
}
