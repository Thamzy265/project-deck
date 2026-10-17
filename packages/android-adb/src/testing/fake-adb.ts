import type {
  AdbBinaryOptions,
  AdbExecOptions,
  AdbRunner,
  AdbStream,
  AdbStreamHandlers,
} from '../adb.js';
import { AdbExitError, AdbMissingError, AdbOutputTooLargeError } from '../adb.js';
import {
  ADB_DEVICES_FIXTURE,
  FIXTURE_PACKAGE,
  FIXTURE_PID,
  FIXTURE_SERIAL,
  RUN_AS_NOT_DEBUGGABLE,
  RUN_AS_UNKNOWN_PACKAGE,
} from './fixtures.js';

/** Files of one app's private folder by relative path, or how run-as refuses. */
export type FakeAppFiles = Record<string, Buffer | string> | 'not-debuggable';

export interface FakeAdbOptions {
  /**
   * serial → package → files, answered by `exec-out run-as <pkg> ls -1 <dir>`,
   * `cat -- <path>` and `head -c <n> -- <path>`. Packages not listed are unknown.
   */
  files?: Record<string, Record<string, FakeAppFiles>>;
  /** `adb devices` output. */
  devices?: string;
  /** serial → pid → process name, answered by `shell ps -o NAME= -p <pid>`. */
  processes?: Record<string, Record<number, string>>;
  /** serial → `getprop ro.build.version.sdk` answer; null makes it fail. Defaults to '35'. */
  sdk?: Record<string, string | null>;
  /** Behave as if adb is not installed. */
  missing?: boolean;
}

/** A logcat (or other long-running) command started through the fake. */
export class FakeAdbStream implements AdbStream {
  killed = false;
  private ended = false;

  constructor(
    readonly args: readonly string[],
    private readonly handlers: AdbStreamHandlers,
  ) {}

  /** Sends text as if adb printed it. */
  emit(text: string): void {
    if (!this.killed && !this.ended) this.handlers.onData(text);
  }

  /** Ends the stream as if adb exited on its own. */
  end(err?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.handlers.onExit(err);
  }

  kill(): void {
    if (this.killed || this.ended) return;
    this.killed = true;
    this.end();
  }
}

/** In-memory adb for tests and dashboard development. Defaults to one emulator running the fixture app. */
export class FakeAdb implements AdbRunner {
  readonly calls: (readonly string[])[] = [];
  readonly streams: FakeAdbStream[] = [];
  private readonly opts: Required<FakeAdbOptions>;

  constructor(opts: FakeAdbOptions = {}) {
    this.opts = {
      devices: opts.devices ?? ADB_DEVICES_FIXTURE,
      processes: opts.processes ?? { [FIXTURE_SERIAL]: { [FIXTURE_PID]: FIXTURE_PACKAGE } },
      sdk: opts.sdk ?? {},
      missing: opts.missing ?? false,
      files: opts.files ?? {},
    };
  }

  /** Changes a fake file, as the app writing to its database would. */
  setFile(serial: string, pkg: string, path: string, content: Buffer | undefined): void {
    const app = this.opts.files[serial]?.[pkg];
    if (app === undefined || app === 'not-debuggable') throw new Error('No such fake app');
    if (content === undefined) Reflect.deleteProperty(app, path);
    else app[path] = content;
  }

  execBinary(args: readonly string[], opts: AdbBinaryOptions): Promise<Buffer> {
    this.calls.push(args);
    if (this.opts.missing) return Promise.reject(new AdbMissingError('adb'));
    try {
      const out = this.runAs(args);
      if (out === undefined) throw new Error(`FakeAdb: unexpected command ${args.join(' ')}`);
      if (out.length > opts.maxBytes) throw new AdbOutputTooLargeError(opts.maxBytes);
      return Promise.resolve(out);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** `-s <serial> exec-out run-as <pkg> <ls|cat|head> …`, or undefined for anything else. */
  private runAs(args: readonly string[]): Buffer | undefined {
    const [s, serial, execOut, runAs, pkg, cmd, ...rest] = args;
    if (s !== '-s' || execOut !== 'exec-out' || runAs !== 'run-as') return undefined;
    if (serial === undefined || pkg === undefined) return undefined;
    const app = this.opts.files[serial]?.[pkg];
    if (app === undefined) throw new AdbExitError(1, null, RUN_AS_UNKNOWN_PACKAGE);
    if (app === 'not-debuggable') throw new AdbExitError(1, null, RUN_AS_NOT_DEBUGGABLE);
    const missing = (path: string) => new AdbExitError(1, null, `cat: ${path}: No such file`);
    if (cmd === 'ls' && rest.length === 2 && rest[0] === '-1') {
      const dir = `${rest[1] ?? ''}/`;
      const names = Object.keys(app)
        .filter((p) => p.startsWith(dir) && !p.slice(dir.length).includes('/'))
        .map((p) => p.slice(dir.length))
        .sort();
      return Buffer.from(names.map((n) => `${n}\n`).join(''));
    }
    if (cmd === 'cat' && rest.length === 2 && rest[0] === '--') {
      const file = app[rest[1] ?? ''];
      if (file === undefined) throw missing(rest[1] ?? '');
      return Buffer.from(file);
    }
    if (cmd === 'head' && rest.length === 4 && rest[0] === '-c' && rest[2] === '--') {
      const file = app[rest[3] ?? ''];
      if (file === undefined) throw missing(rest[3] ?? '');
      return Buffer.from(file).subarray(0, Number(rest[1]));
    }
    return undefined;
  }

  exec(args: readonly string[], _opts?: AdbExecOptions): Promise<string> {
    this.calls.push(args);
    if (this.opts.missing) return Promise.reject(new AdbMissingError('adb'));
    try {
      const out = this.runAs(args);
      if (out !== undefined) return Promise.resolve(out.toString('utf8'));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    if (args.length === 1 && args[0] === 'devices') return Promise.resolve(this.opts.devices);
    if (args.length === 1 && args[0] === 'version')
      return Promise.resolve('Android Debug Bridge version 1.0.41\n');
    if (
      args.length === 5 &&
      args[0] === '-s' &&
      args[2] === 'shell' &&
      args[3] === 'getprop' &&
      args[4] === 'ro.build.version.sdk'
    ) {
      const sdk = this.opts.sdk[args[1] ?? ''];
      return sdk === null
        ? Promise.reject(new Error('adb exited with code 1'))
        : Promise.resolve(`${sdk ?? '35'}\n`);
    }
    if (
      args.length === 5 &&
      args[0] === '-s' &&
      args[2] === 'shell' &&
      args[3] === 'ps' &&
      /^\d+$/.test(args[4] ?? '')
    ) {
      // Old toolbox ps: a header, then a row per matching process with NAME last.
      const name = this.opts.processes[args[1] ?? '']?.[Number(args[4])];
      const header = 'USER      PID   PPID  VSIZE  RSS   WCHAN              PC  NAME\n';
      const row = `u0_a86    ${args[4] ?? ''}  1234  1003924 98712 SyS_epoll_ 00000000 S ${name ?? ''}\n`;
      return Promise.resolve(name === undefined ? header : header + row);
    }
    const [s, serial, shell, ps, o, fmt, p, pid] = args;
    if (
      args.length === 8 &&
      s === '-s' &&
      shell === 'shell' &&
      ps === 'ps' &&
      o === '-o' &&
      fmt === 'NAME=' &&
      p === '-p'
    ) {
      const name = this.opts.processes[serial ?? '']?.[Number(pid)];
      // Like toybox ps: nothing printed and a non-zero exit when the pid doesn't exist.
      return name === undefined
        ? Promise.reject(new Error('adb exited with code 1'))
        : Promise.resolve(`${name}\n`);
    }
    return Promise.reject(new Error(`FakeAdb: unexpected command ${args.join(' ')}`));
  }

  stream(args: readonly string[], handlers: AdbStreamHandlers): FakeAdbStream {
    this.calls.push(args);
    const stream = new FakeAdbStream(args, handlers);
    this.streams.push(stream);
    if (this.opts.missing) stream.end(new AdbMissingError('adb'));
    return stream;
  }
}
