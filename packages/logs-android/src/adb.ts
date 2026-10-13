import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** adb itself is not installed or not where we looked. */
export class AdbMissingError extends Error {
  constructor(readonly path: string) {
    super(`adb was not found (looked for '${path}')`);
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
 * Where adb lives. Android Studio installs it in the SDK without adding it to the
 * PATH, so look in the SDK first and fall back to `adb` on the PATH.
 */
export function resolveAdbPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  exists: (path: string) => boolean = existsSync,
): string {
  const exe = platform === 'win32' ? 'adb.exe' : 'adb';
  const sdks = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT];
  if (platform === 'darwin') sdks.push(join(home, 'Library', 'Android', 'sdk'));
  else if (platform === 'win32') {
    if (env.LOCALAPPDATA !== undefined) sdks.push(join(env.LOCALAPPDATA, 'Android', 'Sdk'));
  } else sdks.push(join(home, 'Android', 'Sdk'));
  for (const sdk of sdks) {
    if (sdk === undefined || sdk === '') continue;
    const candidate = join(sdk, 'platform-tools', exe);
    if (exists(candidate)) return candidate;
  }
  return 'adb';
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

/** Runs the real adb binary at `path` with execFile/spawn and never a shell. */
export function nodeAdb(path: string = resolveAdbPath(), opts: NodeAdbOptions = {}): AdbRunner {
  return {
    exec(args) {
      return new Promise((resolve, reject) => {
        const child = execFile(
          path,
          args,
          {
            shell: false,
            windowsHide: true,
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
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      child.on('error', (err) => finish(isNotFound(err) ? new AdbMissingError(path) : err));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (text: string) => handlers.onData(text));
      child.stdout.on('error', (err) => finish(err));
      child.on('close', (code, signal) => {
        if (killed || code === 0) finish(undefined);
        else
          finish(
            new Error(
              `adb exited with ${code === null ? `signal ${signal ?? '?'}` : `code ${code}`}`,
            ),
          );
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
