import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

/** adb itself is not installed or not where we looked. */
export class AdbMissingError extends Error {
  constructor(readonly path: string) {
    super(`adb was not found (looked for '${path}')`);
  }
}

/** An adb command ended with a failure exit. */
export class AdbExitError extends Error {
  constructor(
    readonly code: number | null,
    readonly signal: string | null,
    /** The start of what it printed on stderr (device text: never shown as is). */
    readonly stderr = '',
  ) {
    super(`adb exited with ${code === null ? `signal ${signal ?? '?'}` : `code ${code}`}`);
  }
}

/** An adb command ran past its timeout and was killed. */
export class AdbTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`adb didn't answer in ${timeoutMs} ms`);
  }
}

/** An adb command printed more than its cap and was killed. */
export class AdbOutputTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`adb printed more than ${maxBytes} bytes`);
  }
}

export interface AdbExecOptions {
  /** Kills the command after this long. Defaults to the runner's timeout. */
  timeoutMs?: number;
}

export interface AdbBinaryOptions {
  /** Kills the command after this long. */
  timeoutMs: number;
  /** Kills the command once its stdout passes this many bytes. */
  maxBytes: number;
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
  /** Runs a short adb command and resolves to its stdout (at most 1 MB). */
  exec(args: readonly string[], opts?: AdbExecOptions): Promise<string>;
  /** Runs an adb command whose stdout is binary, such as `exec-out … cat`. */
  execBinary(args: readonly string[], opts: AdbBinaryOptions): Promise<Buffer>;
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
  // The target platform's path rules, not the host's, so results don't depend on where this runs.
  const path = win ? win32 : posix;
  const exe = win ? 'adb.exe' : 'adb';
  // A relative directory would resolve against the cwd, so every source must be absolute.
  const absolute = (dir: string | undefined): dir is string =>
    dir !== undefined && path.isAbsolute(dir);
  const sdks: (string | undefined)[] = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT];
  if (platform === 'darwin') sdks.push(path.join(home, 'Library', 'Android', 'sdk'));
  else if (win) {
    if (absolute(env.LOCALAPPDATA)) sdks.push(path.join(env.LOCALAPPDATA, 'Android', 'Sdk'));
  } else sdks.push(path.join(home, 'Android', 'Sdk'));
  const dirs = [
    ...sdks.filter(absolute).map((sdk) => path.join(sdk, 'platform-tools')),
    ...(env.PATH ?? env.Path ?? '').split(win ? ';' : ':').filter(absolute),
  ];
  const candidates = dirs.map((dir) => path.join(dir, exe));
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

/** Bytes of stderr kept for error detection (run-as messages are one short line). */
const MAX_STDERR = 4096;
/** How long a stopped command gets to exit on SIGTERM before SIGKILL. */
export const KILL_GRACE_MS = 1000;

/** SIGTERM now, SIGKILL after the grace if the process is still there. */
export function killHard(child: {
  kill(signal?: NodeJS.Signals): boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once(event: 'close', cb: () => void): unknown;
}): void {
  child.kill();
  const grace = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, KILL_GRACE_MS);
  grace.unref();
  child.once('close', () => clearTimeout(grace));
}

/**
 * Runs adb once and collects its stdout, never through a shell. The process is killed
 * when it passes `timeoutMs` or prints more than `maxBytes`, so a device that stops
 * answering or a huge file can't hang or exhaust the daemon.
 */
function collect(
  path: string,
  args: readonly string[],
  timeoutMs: number,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let failure: Error | undefined;
    let settled = false;
    const child = spawn(path, args, {
      shell: false,
      windowsHide: true,
      cwd: homedir(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Rejects at once; a process that ignores SIGTERM gets SIGKILL after a short grace.
    const stop = (err: Error): void => {
      if (failure !== undefined) return;
      failure = err;
      finish(err);
      killHard(child);
    };
    const timer = setTimeout(() => stop(new AdbTimeoutError(timeoutMs)), timeoutMs);
    const finish = (err: Error | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err === undefined) resolve(Buffer.concat(chunks, size));
      else reject(err);
    };
    child.on('error', (err) => {
      clearTimeout(timer);
      finish(isNotFound(err) ? new AdbMissingError(path) : (failure ?? err));
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure !== undefined) return;
      size += chunk.length;
      if (size > maxBytes) {
        stop(new AdbOutputTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text: string) => {
      if (stderr.length < MAX_STDERR) stderr = (stderr + text).slice(0, MAX_STDERR);
    });
    child.stdout.on('error', (err) => stop(err));
    child.stderr.on('error', (err) => stop(err));
    child.on('close', (code, signal) => {
      if (failure !== undefined) finish(failure);
      else if (code === 0) finish(undefined);
      else finish(new AdbExitError(code, signal, stderr));
    });
  });
}

/**
 * Runs the real adb binary at `path` with spawn, never a shell, from the home
 * directory. `null` means adb wasn't found: every call then fails with AdbMissingError.
 */
export function nodeAdb(
  path: string | null = resolveAdbPath() ?? null,
  opts: NodeAdbOptions = {},
): AdbRunner {
  if (path === null) return missingAdb();
  return {
    async exec(args, execOpts = {}) {
      const timeoutMs = execOpts.timeoutMs ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      return (await collect(path, args, timeoutMs, MAX_EXEC_OUTPUT)).toString('utf8');
    },

    execBinary(args, binaryOpts) {
      return collect(path, args, binaryOpts.timeoutMs, binaryOpts.maxBytes);
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
    execBinary: () => Promise.reject(new AdbMissingError('adb')),
    stream(_args, handlers) {
      // Asynchronous like a failed spawn, so callers can finish setting up first.
      setImmediate(() => handlers.onExit(new AdbMissingError('adb')));
      return { kill: () => undefined };
    },
  };
}
