import type { LogEntry, LogFeedFactory, RunningApp } from '@project-deck/core';
import type { AdbRunner } from './adb.js';
import {
  AdbExitError,
  AdbMissingError,
  isPackageName,
  isPid,
  nodeAdb,
  parseDevices,
} from './adb.js';
import { ThreadtimeParser } from './threadtime.js';

export interface AndroidLogFeedOptions {
  /** Defaults to the real adb from the Android SDK or the PATH. */
  adb?: AdbRunner;
  log?: (message: string, err?: unknown) => void;
  /** How long logcat must be quiet before the last (possibly multi-line) entry is emitted. */
  flushAfterMs?: number;
  /**
   * Tags (exact, case-sensitive) whose entries are dropped. Defaults to `flutter`: the
   * VM service already delivers Dart's print output with real timestamps and without
   * logcat's line-length limit. Pass `[]` to keep everything.
   */
  dropTags?: readonly string[];
  now?: () => Date;
}

const DEFAULT_FLUSH_AFTER_MS = 100;
/** `logcat -v epoch` exists from Android 7.0 (API 24). */
const EPOCH_MIN_SDK = 24;
export const DEFAULT_DROP_TAGS: readonly string[] = ['flutter'];

function exitDetail(err: Error | undefined): string {
  if (err === undefined) return 'code 0';
  if (err instanceof AdbExitError) {
    return err.code === null ? `signal ${err.signal ?? 'unknown'}` : `code ${err.code}`;
  }
  return err.message;
}

/**
 * Android native logs for the attached app: `adb logcat --pid` on the device that
 * runs it. Only reads logs; never touches the app or the device.
 */
export class AndroidLogFeed implements LogFeedFactory {
  readonly id = 'android-logcat';
  private readonly adb: AdbRunner;
  private warnedMissing = false;

  constructor(private readonly opts: AndroidLogFeedOptions = {}) {
    this.adb = opts.adb ?? nodeAdb();
  }

  async open(
    app: RunningApp,
    onEntry: (entry: LogEntry) => void,
  ): Promise<(() => Promise<void>) | undefined> {
    const pid = app.pid;
    if (app.device?.platform !== 'android' || pid === undefined || !isPid(pid)) return undefined;
    const serial = await this.findDevice(pid, app.name);
    if (serial === undefined) return undefined;

    const drop = new Set(this.opts.dropTags ?? DEFAULT_DROP_TAGS);
    // Filter whole entries after grouping, so a dropped multi-line message goes with all its lines.
    let closed = false;
    const parser = new ThreadtimeParser((entry) => {
      // kill() only sends a signal: output already in the pipe can still arrive afterwards.
      if (closed) return;
      if (entry.tag === undefined || !drop.has(entry.tag)) onEntry(entry);
    }, this.opts.now);
    let timer: NodeJS.Timeout | undefined;
    // Epoch seconds avoid guessing the year and the device's timezone (emulators often run in UTC).
    const epoch = ((await this.sdkLevel(serial)) ?? 0) >= EPOCH_MIN_SDK;
    const format = epoch ? ['-v', 'threadtime', '-v', 'epoch'] : ['-v', 'threadtime'];
    const stream = this.adb.stream(['-s', serial, 'logcat', ...format, `--pid=${pid}`], {
      onData: (text) => {
        if (closed) return;
        parser.write(text);
        clearTimeout(timer);
        timer = setTimeout(() => parser.flush(), this.opts.flushAfterMs ?? DEFAULT_FLUSH_AFTER_MS);
        timer.unref();
      },
      onExit: (err) => {
        if (closed) return;
        clearTimeout(timer);
        parser.flush();
        this.report(`Android logcat stopped for pid ${pid} on ${serial}`, err);
        // Say so in the log itself; otherwise native logs just go quiet. No restart.
        onEntry({
          ts: (this.opts.now?.() ?? new Date()).getTime(),
          level: 'warn',
          source: 'tool',
          tag: 'logs-android',
          message: `Android native logs stopped: logcat exited (${exitDetail(err)})`,
        });
      },
    });
    return () => {
      if (closed) return Promise.resolve();
      // A crash is often the last thing logged: emit what arrived before close, then nothing more.
      clearTimeout(timer);
      parser.flush();
      closed = true;
      stream.kill();
      return Promise.resolve();
    };
  }

  /**
   * The serial of the online device running `pid`. Pids are only unique per device,
   * so ask each one what runs at that pid and prefer the app's own package name.
   * The connector rarely knows the package name, so otherwise take the first device
   * whose process there looks like an app: with several devices that is a guess, but
   * a wrong guess only shows another app's logs and the common case is one emulator.
   */
  private async findDevice(pid: number, appName: string): Promise<string | undefined> {
    let serials: string[];
    try {
      serials = parseDevices(await this.adb.exec(['devices']));
    } catch (err) {
      if (err instanceof AdbMissingError) {
        if (!this.warnedMissing) {
          this.warnedMissing = true;
          this.report(`${err.message}; Android native logs are off`);
        }
      } else {
        this.report('Could not list Android devices', err);
      }
      return undefined;
    }
    if (serials.length === 0) return undefined;
    const names = await Promise.all(
      serials.map((serial) =>
        this.adb
          .exec(['-s', serial, 'shell', 'ps', '-o', 'NAME=', '-p', String(pid)])
          .then((out) => out.split('\n')[0]?.trim() ?? '')
          .catch(() => ''),
      ),
    );
    const at = (match: (name: string) => boolean): string | undefined =>
      serials[names.findIndex(match)];
    return (
      (isPackageName(appName) ? at((n) => n === appName) : undefined) ??
      at(isPackageName) ??
      at((n) => n !== '') ??
      // Old Android without `ps -o` can't tell us, but with one device it must be that one.
      (serials.length === 1 ? serials[0] : undefined)
    );
  }

  /** The device's API level, or undefined when it can't be read. */
  private async sdkLevel(serial: string): Promise<number | undefined> {
    try {
      const out = (
        await this.adb.exec(['-s', serial, 'shell', 'getprop', 'ro.build.version.sdk'])
      ).trim();
      return /^\d{1,3}$/.test(out) ? Number(out) : undefined;
    } catch {
      return undefined;
    }
  }

  private report(message: string, err?: unknown): void {
    this.opts.log?.(message, err);
  }
}
