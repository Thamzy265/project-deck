import type { LogEntry, LogFeedFactory, RunningApp } from '@project-deck/core';
import type { AdbRunner } from './adb.js';
import { AdbMissingError, isPackageName, isPid, nodeAdb, parseDevices } from './adb.js';
import { ThreadtimeParser } from './threadtime.js';

export interface AndroidLogFeedOptions {
  /** Defaults to the real adb from the Android SDK or the PATH. */
  adb?: AdbRunner;
  log?: (message: string, err?: unknown) => void;
  /** How long logcat must be quiet before the last (possibly multi-line) entry is emitted. */
  flushAfterMs?: number;
  now?: () => Date;
}

const DEFAULT_FLUSH_AFTER_MS = 100;

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

    const parser = new ThreadtimeParser(onEntry, this.opts.now);
    let timer: NodeJS.Timeout | undefined;
    let closed = false;
    const stream = this.adb.stream(['-s', serial, 'logcat', '-v', 'threadtime', `--pid=${pid}`], {
      onData: (text) => {
        parser.write(text);
        clearTimeout(timer);
        timer = setTimeout(() => parser.flush(), this.opts.flushAfterMs ?? DEFAULT_FLUSH_AFTER_MS);
        timer.unref();
      },
      onExit: (err) => {
        clearTimeout(timer);
        parser.flush();
        if (closed || err === undefined) return;
        this.report(`Android logcat stopped for pid ${pid} on ${serial}`, err);
      },
    });
    return () => {
      closed = true;
      stream.kill();
      // A crash is often the last thing logged; don't lose it to the quiet-period timer.
      clearTimeout(timer);
      parser.flush();
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

  private report(message: string, err?: unknown): void {
    this.opts.log?.(message, err);
  }
}
