import type { LogEntry, LogFeedFactory, RunningApp } from '@project-deck/core';
import type { AdbRunner } from './adb.js';
import {
  AdbExitError,
  AdbMissingError,
  isPackageName,
  isPid,
  nodeAdb,
  parseDevices,
  parsePsName,
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
  /**
   * On close, keep reading until logcat has been quiet this long, so the crash lines
   * that follow an app exit are captured.
   */
  drainQuietMs?: number;
  /** Upper bound on that wait, for an app that never stops logging. */
  drainMaxMs?: number;
  now?: () => Date;
}

const DEFAULT_FLUSH_AFTER_MS = 100;
const DEFAULT_DRAIN_QUIET_MS = 200;
const DEFAULT_DRAIN_MAX_MS = 1000;
/** `logcat --pid` and `-v epoch` exist from Android 7.0 (API 24). */
const PID_FILTER_MIN_SDK = 24;
/** Before Android 8.0 (API 26), `ps` is toolbox, which has no `-o` or `-p <pid>`. */
const TOYBOX_PS_MIN_SDK = 26;

interface Device {
  serial: string;
  sdk: number | undefined;
  /** Process name at the pid, or '' when ps couldn't say. */
  process: string;
}
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
 * Known limitation: native crash tombstones are logged by debuggerd (tag DEBUG) under
 * another pid, so `--pid` doesn't capture them.
 */
export class AndroidLogFeed implements LogFeedFactory {
  readonly id = 'android-logcat';
  private readonly adb: AdbRunner;
  private warnedMissing = false;
  private warnedOldSdk = false;

  constructor(private readonly opts: AndroidLogFeedOptions = {}) {
    this.adb = opts.adb ?? nodeAdb();
  }

  async open(
    app: RunningApp,
    onEntry: (entry: LogEntry) => void,
  ): Promise<(() => Promise<void>) | undefined> {
    const pid = app.pid;
    if (app.device?.platform !== 'android' || pid === undefined || !isPid(pid)) return undefined;
    const device = await this.findDevice(pid, app.name);
    if (device === undefined) return undefined;
    const { serial } = device;
    if (device.sdk !== undefined && device.sdk < PID_FILTER_MIN_SDK) {
      if (!this.warnedOldSdk) {
        this.warnedOldSdk = true;
        this.report('Android native logs need Android 7.0 (API 24) or newer');
      }
      return undefined;
    }

    const drop = new Set(this.opts.dropTags ?? DEFAULT_DROP_TAGS);
    // Filter whole entries after grouping, so a dropped multi-line message goes with all its lines.
    let closed = false;
    const parser = new ThreadtimeParser((entry) => {
      // kill() only sends a signal: output already in the pipe can still arrive afterwards.
      if (closed) return;
      if (entry.tag === undefined || !drop.has(entry.tag)) onEntry(entry);
    }, this.opts.now);
    let timer: NodeJS.Timeout | undefined;
    let exited = false;
    /** Set while close() drains; called on every chunk and on exit. */
    let drainWake: ((ended: boolean) => void) | undefined;
    // Epoch seconds avoid guessing the year and the device's timezone (emulators often run
    // in UTC). If the API level couldn't be read, plain threadtime is the safe choice.
    const epoch = device.sdk !== undefined;
    const format = epoch ? ['-v', 'threadtime', '-v', 'epoch'] : ['-v', 'threadtime'];
    const stream = this.adb.stream(['-s', serial, 'logcat', ...format, `--pid=${pid}`], {
      onData: (text) => {
        if (closed) return;
        parser.write(text);
        clearTimeout(timer);
        timer = setTimeout(() => parser.flush(), this.opts.flushAfterMs ?? DEFAULT_FLUSH_AFTER_MS);
        timer.unref();
        drainWake?.(false);
      },
      onExit: (err) => {
        exited = true;
        if (closed) return;
        clearTimeout(timer);
        parser.flush();
        if (drainWake !== undefined) {
          // We are closing anyway: not worth a warning.
          drainWake(true);
          return;
        }
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

    // Resolves once logcat has been quiet for drainQuietMs, has exited, or drainMaxMs passed.
    const drain = (): Promise<void> =>
      new Promise((resolve) => {
        if (exited) {
          resolve();
          return;
        }
        const quietMs = this.opts.drainQuietMs ?? DEFAULT_DRAIN_QUIET_MS;
        let quiet = setTimeout(done, quietMs);
        const cap = setTimeout(done, this.opts.drainMaxMs ?? DEFAULT_DRAIN_MAX_MS);
        drainWake = (ended) => {
          clearTimeout(quiet);
          if (ended) done();
          else quiet = setTimeout(done, quietMs);
        };
        function done(): void {
          clearTimeout(quiet);
          clearTimeout(cap);
          resolve();
        }
      });

    let closing: Promise<void> | undefined;
    return () => {
      closing ??= (async () => {
        try {
          // A crash is logged just as the app goes away: read it before stopping logcat.
          await drain();
          clearTimeout(timer);
          parser.flush();
        } finally {
          // Even if onEntry threw, logcat must not outlive the feed.
          closed = true;
          clearTimeout(timer);
          stream.kill();
        }
      })();
      return closing;
    };
  }

  /**
   * The online device running `pid`, with its API level. Pids are only unique per
   * device, so ask each one what runs at that pid. Only a process whose name is an
   * Android package counts (a system process such as `system_server` rules the device
   * out), preferring the app's own package name. The connector rarely knows that name,
   * so with several devices the first package wins: a guess, but a wrong one only shows
   * another app's logs, and the common case is one emulator.
   */
  private async findDevice(pid: number, appName: string): Promise<Device | undefined> {
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
    const devices = await Promise.all(serials.map((serial) => this.probe(serial, pid)));
    const exact = isPackageName(appName) ? devices.find((d) => d.process === appName) : undefined;
    const only = devices.length === 1 ? devices[0] : undefined;
    return (
      exact ??
      devices.find((d) => isPackageName(d.process)) ??
      // ps gave no usable name at all (unsupported); with one device it must be that one.
      (only?.process === '' ? only : undefined)
    );
  }

  /** What runs at `pid` on the device ('' when unknown) and the device's API level. */
  private async probe(serial: string, pid: number): Promise<Device> {
    const sdk = await this.sdkLevel(serial);
    // Toybox ps (API 26+) filters by pid; old toolbox ps takes the pid as an argument.
    const ps =
      sdk !== undefined && sdk < TOYBOX_PS_MIN_SDK
        ? ['ps', String(pid)]
        : ['ps', '-o', 'NAME=', '-p', String(pid)];
    const process = await this.adb
      .exec(['-s', serial, 'shell', ...ps])
      .then((out) => parsePsName(out, pid))
      .catch(() => '');
    return { serial, sdk, process };
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
