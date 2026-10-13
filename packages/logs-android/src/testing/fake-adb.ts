import type { AdbRunner, AdbStream, AdbStreamHandlers } from '../adb.js';
import { AdbMissingError } from '../adb.js';
import { ADB_DEVICES_FIXTURE, FIXTURE_PACKAGE, FIXTURE_PID, FIXTURE_SERIAL } from './fixtures.js';

export interface FakeAdbOptions {
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
    };
  }

  exec(args: readonly string[]): Promise<string> {
    this.calls.push(args);
    if (this.opts.missing) return Promise.reject(new AdbMissingError('adb'));
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
