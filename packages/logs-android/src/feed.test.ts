import type { LogEntry, RunningApp } from '@project-deck/core';
import { Registry } from '@project-deck/core';
import { describe, expect, it, vi } from 'vitest';
import type { AdbStreamHandlers } from './adb.js';
import { AdbExitError, AdbMissingError } from './adb.js';
import type { AndroidLogFeedOptions } from './feed.js';
import { AndroidLogFeed } from './feed.js';
import { FakeAdb, FakeAdbStream } from './testing/fake-adb.js';
import {
  FIXTURE_PACKAGE,
  FIXTURE_PID,
  EPOCH_FIXTURE,
  FIXTURE_SERIAL,
  THREADTIME_FIXTURE,
} from './testing/fixtures.js';

const androidApp: RunningApp = {
  id: 'dart-1',
  name: FIXTURE_PACKAGE,
  device: { id: 'unknown', name: 'Android device', platform: 'android' },
  pid: FIXTURE_PID,
  framework: 'flutter',
  startedBy: 'ide',
};

const TWO_DEVICES = 'List of devices attached\nemulator-5554\tdevice\nR58M123ABC\tdevice\n';
const logcatArgs = (serial: string): string[] => [
  '-s',
  serial,
  'logcat',
  '-v',
  'threadtime',
  '-v',
  'epoch',
  `--pid=${FIXTURE_PID}`,
];

function setup(adb: FakeAdb, opts: Omit<AndroidLogFeedOptions, 'adb'> = {}) {
  const log = vi.fn();
  const feed = new AndroidLogFeed({ adb, log, flushAfterMs: 5, ...opts });
  const entries: LogEntry[] = [];
  const open = (app: RunningApp = androidApp) => feed.open(app, (e) => entries.push(e));
  return { feed, log, entries, open };
}

describe('AndroidLogFeed', () => {
  it('registers as a log feed', () => {
    const registry = new Registry();
    registry.logFeeds.register(new AndroidLogFeed({ adb: new FakeAdb() }));
    expect(registry.logFeeds.get('android-logcat')).toBeInstanceOf(AndroidLogFeed);
  });

  it('streams logcat for the app pid as native entries', async () => {
    const adb = new FakeAdb();
    const { entries, open } = setup(adb);
    const close = await open();
    expect(close).toBeTypeOf('function');
    const [stream] = adb.streams;
    expect(stream?.args).toEqual(logcatArgs(FIXTURE_SERIAL));
    stream?.emit(THREADTIME_FIXTURE);
    await vi.waitFor(() => expect(entries).toHaveLength(9));
    expect(entries.every((e) => e.source === 'native')).toBe(true);
    expect(entries.at(-1)).toMatchObject({ level: 'fatal', tag: 'libc' });
    await close?.();
  });

  it('asks the device its API level with a fixed getprop', async () => {
    const adb = new FakeAdb();
    const close = await setup(adb).open();
    expect(adb.calls).toContainEqual([
      '-s',
      FIXTURE_SERIAL,
      'shell',
      'getprop',
      'ro.build.version.sdk',
    ]);
    await close?.();
  });

  it.each([
    ['API 23', { [FIXTURE_SERIAL]: '23' }],
    ['a getprop failure', { [FIXTURE_SERIAL]: null }],
    ['a non-numeric answer', { [FIXTURE_SERIAL]: '35; reboot' }],
  ])('falls back to plain threadtime on %s', async (_, sdk) => {
    const adb = new FakeAdb({ sdk });
    const close = await setup(adb).open();
    expect(adb.streams[0]?.args).toEqual([
      '-s',
      FIXTURE_SERIAL,
      'logcat',
      '-v',
      'threadtime',
      `--pid=${FIXTURE_PID}`,
    ]);
    await close?.();
  });

  it('uses epoch time from API 24', async () => {
    const adb = new FakeAdb({ sdk: { [FIXTURE_SERIAL]: '24' } });
    const { open, entries } = setup(adb);
    const close = await open();
    expect(adb.streams[0]?.args).toEqual(logcatArgs(FIXTURE_SERIAL));
    adb.streams[0]?.emit(EPOCH_FIXTURE);
    await vi.waitFor(() => expect(entries).toHaveLength(4));
    expect(entries[0]?.ts).toBe(1697050000123);
    await close?.();
  });

  it("drops lines tagged 'flutter' by default; the VM service already has them", async () => {
    const adb = new FakeAdb();
    const { entries, open } = setup(adb);
    const close = await open();
    adb.streams[0]?.emit(THREADTIME_FIXTURE);
    await vi.waitFor(() => expect(entries).toHaveLength(9));
    expect(entries.some((e) => e.tag === 'flutter')).toBe(false);
    expect(entries.filter((e) => e.tag === 'FlutterJNI')).toHaveLength(2);
    await close?.();
  });

  it('keeps flutter lines when dropTags is empty', async () => {
    const adb = new FakeAdb();
    const { entries, open } = setup(adb, { dropTags: [] });
    const close = await open();
    adb.streams[0]?.emit(THREADTIME_FIXTURE);
    await vi.waitFor(() => expect(entries).toHaveLength(11));
    expect(entries.filter((e) => e.tag === 'flutter')).toHaveLength(2);
    await close?.();
  });

  it('drops a whole multi-line flutter entry without touching its neighbours', async () => {
    const adb = new FakeAdb();
    const { entries, open } = setup(adb, { flushAfterMs: 60_000 });
    const close = await open();
    adb.streams[0]?.emit(
      [
        '10-13 14:02:40.001  4242  4281 I flutter : Exception caught by widgets library',
        '10-13 14:02:40.001  4242  4281 I flutter : #0      main (package:shop/main.dart:12:3)',
        '10-13 14:02:40.002  4242  4281 E Flutter : engine line one',
        '10-13 14:02:40.002  4242  4281 E Flutter : \tat io.flutter.Foo.bar(Foo.java:1)',
        '10-13 14:02:40.003  4242  4281 I flutter : trailing print',
        '',
      ].join('\n'),
    );
    await close?.();
    expect(entries).toEqual([
      expect.objectContaining({
        tag: 'Flutter',
        message: 'engine line one',
        stack: '\tat io.flutter.Foo.bar(Foo.java:1)',
      }),
    ]);
  });

  it.each([
    ['another platform', { device: { id: 'x', name: 'iPhone', platform: 'ios' as const } }],
    ['no device', { device: undefined }],
    ['no pid', { pid: undefined }],
    ['a bad pid', { pid: -5 }],
  ])('does not apply to an app with %s, without running adb', async (_, change) => {
    const adb = new FakeAdb();
    const { open } = setup(adb);
    const app: RunningApp = { ...androidApp };
    if ('device' in change) {
      if (change.device === undefined) delete app.device;
      else app.device = change.device;
    }
    if ('pid' in change) {
      if (change.pid === undefined) delete app.pid;
      else app.pid = change.pid;
    }
    expect(await open(app)).toBeUndefined();
    expect(adb.calls).toEqual([]);
  });

  it('prefers the device whose process at the pid is the app', async () => {
    const adb = new FakeAdb({
      devices: TWO_DEVICES,
      processes: {
        'emulator-5554': { [FIXTURE_PID]: 'com.other.app' },
        R58M123ABC: { [FIXTURE_PID]: FIXTURE_PACKAGE },
      },
    });
    const close = await setup(adb).open();
    expect(adb.streams[0]?.args).toEqual(logcatArgs('R58M123ABC'));
    await close?.();
  });

  it('takes the first device with an app-like process when none matches the name', async () => {
    const adb = new FakeAdb({
      devices: TWO_DEVICES,
      processes: {
        'emulator-5554': { [FIXTURE_PID]: 'kworker/0:1' },
        R58M123ABC: { [FIXTURE_PID]: 'com.example.shop' },
      },
    });
    const close = await setup(adb).open({ ...androidApp, name: 'Shop (debug)' });
    expect(adb.streams[0]?.args).toEqual(logcatArgs('R58M123ABC'));
    await close?.();
  });

  it('uses the only device even if ps cannot report the process', async () => {
    const adb = new FakeAdb({
      devices: 'List of devices attached\nemulator-5554\tdevice\n',
      processes: {},
    });
    const close = await setup(adb).open();
    expect(adb.streams[0]?.args).toEqual(logcatArgs('emulator-5554'));
    await close?.();
  });

  it('does not apply when several devices are online and none runs the pid', async () => {
    const adb = new FakeAdb({ devices: TWO_DEVICES, processes: {} });
    expect(await setup(adb).open()).toBeUndefined();
    expect(adb.streams).toEqual([]);
  });

  it('does not apply when no device is online', async () => {
    const adb = new FakeAdb({ devices: 'List of devices attached\n\n' });
    expect(await setup(adb).open()).toBeUndefined();
  });

  it('logs a missing adb once and never throws', async () => {
    const adb = new FakeAdb({ missing: true });
    const { open, log } = setup(adb);
    expect(await open()).toBeUndefined();
    expect(await open()).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatch(/adb was not found/);
  });

  it('logs other adb failures without throwing', async () => {
    const adb = new FakeAdb();
    vi.spyOn(adb, 'exec').mockRejectedValue(new Error('adb server version mismatch'));
    const { open, log } = setup(adb);
    expect(await open()).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/Android devices/), expect.any(Error));
  });

  it('emits a held multi-line entry once the stream goes quiet', async () => {
    const adb = new FakeAdb();
    const { open, entries } = setup(adb);
    const close = await open();
    adb.streams[0]?.emit(
      '10-13 14:02:35.442  4242  4242 E AndroidRuntime: FATAL EXCEPTION: main\n',
    );
    adb.streams[0]?.emit('10-13 14:02:35.442  4242  4242 E AndroidRuntime: \tat a.B.c(B.java:1)\n');
    await vi.waitFor(() =>
      expect(entries).toEqual([
        expect.objectContaining({
          message: 'FATAL EXCEPTION: main',
          stack: '\tat a.B.c(B.java:1)',
        }),
      ]),
    );
    await close?.();
  });

  it('kills logcat on close and keeps the last entry', async () => {
    const adb = new FakeAdb();
    const { open, entries } = setup(adb, { flushAfterMs: 60_000 });
    const close = await open();
    adb.streams[0]?.emit(
      '10-13 14:02:35.442  4242  4242 E AndroidRuntime: FATAL EXCEPTION: main\n',
    );
    expect(entries).toEqual([]);
    await close?.();
    expect(adb.streams[0]?.killed).toBe(true);
    expect(entries).toHaveLength(1);
    await close?.();
  });

  it('logs when logcat stops on its own', async () => {
    const adb = new FakeAdb();
    const { open, log } = setup(adb);
    const close = await open();
    adb.streams[0]?.end(new Error('adb exited with code 1'));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/logcat stopped/), expect.any(Error));
    await close?.();
  });
});

/**
 * Behaves like nodeAdb's stream: kill() only sends a signal, so output already in the
 * pipe can still arrive, followed by onExit once the process is reaped.
 */
class LaggingAdb extends FakeAdb {
  handlers: AdbStreamHandlers | undefined;
  killCount = 0;

  override stream(args: readonly string[], handlers: AdbStreamHandlers): FakeAdbStream {
    this.handlers = handlers;
    const stream = super.stream(args, { onData: () => undefined, onExit: () => undefined });
    stream.kill = () => {
      this.killCount++;
    };
    return stream;
  }
}

describe('AndroidLogFeed edge cases', () => {
  const header = '10-13 14:02:35.442  4242  4242 E Native  : ';

  it('emits nothing that logcat prints after close', async () => {
    const adb = new LaggingAdb();
    const { open, entries } = setup(adb, { flushAfterMs: 1 });
    const close = await open();
    adb.handlers?.onData(`${header}before close\n`);
    await close?.();
    const seen = entries.length;
    // Still in the pipe when the signal landed, then the process exits.
    adb.handlers?.onData(`${header.replace('35.442', '35.443')}after close\n`);
    adb.handlers?.onExit(undefined);
    await new Promise((r) => setTimeout(r, 20));
    expect(adb.killCount).toBe(1);
    expect(entries).toHaveLength(seen);
  });

  it.fails(
    'BUG: does not stream logs of a system process that happens to have the pid',
    async () => {
      const adb = new FakeAdb({
        devices: TWO_DEVICES,
        // The app runs on a device we can't see (unauthorized, another adb server);
        // the emulator's process at that pid is a system daemon, not the app.
        processes: { 'emulator-5554': { [FIXTURE_PID]: 'system_server' } },
      });
      expect(await setup(adb).open({ ...androidApp, name: 'Shop' })).toBeUndefined();
      expect(adb.streams).toEqual([]);
    },
  );

  it('logs and adds a warning entry when logcat ends on its own without an error', async () => {
    const adb = new FakeAdb();
    const { open, log, entries } = setup(adb, { now: () => new Date(2026, 9, 13, 15) });
    const close = await open();
    adb.streams[0]?.end();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/logcat stopped/), undefined);
    expect(entries).toEqual([
      {
        ts: new Date(2026, 9, 13, 15).getTime(),
        level: 'warn',
        source: 'tool',
        tag: 'logs-android',
        message: 'Android native logs stopped: logcat exited (code 0)',
      },
    ]);
    await close?.();
  });

  it('says which exit code or signal stopped logcat, after the last native entry', async () => {
    const adb = new FakeAdb();
    const { open, entries } = setup(adb, { flushAfterMs: 60_000 });
    const close = await open();
    adb.streams[0]?.emit(`${header}last words\n`);
    adb.streams[0]?.end(new AdbExitError(255, null));
    expect(entries.map((e) => [e.source, e.message])).toEqual([
      ['native', 'last words'],
      ['tool', 'Android native logs stopped: logcat exited (code 255)'],
    ]);
    await close?.();
  });

  it('names the signal or error when logcat has no exit code', async () => {
    for (const [err, detail] of [
      [new AdbExitError(null, 'SIGKILL'), 'signal SIGKILL'],
      [new AdbMissingError('adb'), "adb was not found (looked for 'adb')"],
    ] as const) {
      const adb = new FakeAdb();
      const { open, entries } = setup(adb);
      const close = await open();
      adb.streams[0]?.end(err);
      expect(entries.at(-1)?.message).toBe(
        `Android native logs stopped: logcat exited (${detail})`,
      );
      await close?.();
    }
  });

  it('adds no warning entry when the feed itself closes logcat', async () => {
    const adb = new FakeAdb();
    const { open, entries } = setup(adb);
    const close = await open();
    await close?.();
    expect(entries).toEqual([]);
  });

  it('does not restart logcat after it stops on its own', async () => {
    const adb = new FakeAdb();
    const close = await setup(adb).open();
    adb.streams[0]?.end(new Error('adb exited with code 1'));
    await new Promise((r) => setTimeout(r, 20));
    expect(adb.streams).toHaveLength(1);
    await close?.();
  });

  it('never passes an option-like serial from adb devices to adb', async () => {
    const adb = new FakeAdb({
      devices: 'List of devices attached\n-s\tdevice\n--wait\tdevice\nemulator-5554\tdevice\n',
      processes: { 'emulator-5554': { [FIXTURE_PID]: FIXTURE_PACKAGE } },
    });
    const close = await setup(adb).open();
    expect(adb.calls.flat()).not.toContain('--wait');
    expect(adb.streams[0]?.args).toEqual(logcatArgs('emulator-5554'));
    await close?.();
  });

  it('passes the pid to ps and logcat as plain digits', async () => {
    const adb = new FakeAdb();
    const close = await setup(adb).open();
    expect(adb.calls).toContainEqual([
      '-s',
      FIXTURE_SERIAL,
      'shell',
      'ps',
      '-o',
      'NAME=',
      '-p',
      '4242',
    ]);
    expect(adb.streams[0]?.args.at(-1)).toBe('--pid=4242');
    await close?.();
  });

  it('reads only the first line of ps output, ignoring CRLF and injected lines', async () => {
    const adb = new FakeAdb({
      devices: TWO_DEVICES,
      processes: {
        'emulator-5554': { [FIXTURE_PID]: `kworker/0:1\n${FIXTURE_PACKAGE}` },
        R58M123ABC: { [FIXTURE_PID]: `${FIXTURE_PACKAGE}\r` },
      },
    });
    const close = await setup(adb).open();
    expect(adb.streams[0]?.args).toEqual(logcatArgs('R58M123ABC'));
    await close?.();
  });

  it('when the pid is reused on two devices, picks the one running the named package', async () => {
    const adb = new FakeAdb({
      devices: TWO_DEVICES,
      processes: {
        'emulator-5554': { [FIXTURE_PID]: 'com.other.app' },
        R58M123ABC: { [FIXTURE_PID]: FIXTURE_PACKAGE },
      },
    });
    const close = await setup(adb).open({ ...androidApp, name: FIXTURE_PACKAGE });
    expect(adb.streams[0]?.args).toEqual(logcatArgs('R58M123ABC'));
    await close?.();
  });

  it('keeps logging a missing adb only once across repeated attach and detach', async () => {
    const adb = new FakeAdb({ missing: true });
    const { open, log } = setup(adb);
    for (let i = 0; i < 5; i++) expect(await open()).toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
  });

  it('logs a missing adb when the stream fails to start, after the lookup worked', async () => {
    const adb = new FakeAdb();
    vi.spyOn(adb, 'stream').mockImplementation((args, handlers) => {
      const s = new FakeAdbStream(args, handlers);
      s.end(new AdbMissingError('adb'));
      return s;
    });
    const { open, log } = setup(adb);
    const close = await open();
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/logcat stopped/),
      expect.any(AdbMissingError),
    );
    await close?.();
  });

  it('drops only the exact tag; case variants and other tags are kept', async () => {
    const adb = new FakeAdb();
    const { open, entries } = setup(adb, { flushAfterMs: 60_000 });
    const close = await open();
    adb.streams[0]?.emit(
      ['flutter', 'Flutter', 'FLUTTER', 'flutter_engine', 'flutter ']
        .map((tag, i) => `10-13 14:02:40.00${i}  4242  4281 I ${tag}: m${i}`)
        .join('\n') + '\n',
    );
    await close?.();
    expect(entries.map((e) => e.tag)).toEqual(['Flutter', 'FLUTTER', 'flutter_engine']);
  });

  it('honours custom drop tags', async () => {
    const adb = new FakeAdb();
    const { open, entries } = setup(adb, { flushAfterMs: 60_000, dropTags: ['OkHttp', 'libc'] });
    const close = await open();
    adb.streams[0]?.emit(THREADTIME_FIXTURE);
    await close?.();
    expect(entries.some((e) => e.tag === 'OkHttp' || e.tag === 'libc')).toBe(false);
    expect(entries.filter((e) => e.tag === 'flutter')).toHaveLength(2);
  });

  it('runs one logcat per open and closes each independently', async () => {
    const adb = new FakeAdb();
    const a = setup(adb);
    const closeA = await a.open();
    const closeB = await a.open();
    expect(adb.streams).toHaveLength(2);
    await closeA?.();
    expect(adb.streams.map((s) => s.killed)).toEqual([true, false]);
    await closeB?.();
    expect(adb.streams.map((s) => s.killed)).toEqual([true, true]);
  });

  it('survives adb devices hanging until it times out', async () => {
    const adb = new FakeAdb();
    vi.spyOn(adb, 'exec').mockRejectedValue(new Error('Command failed: adb devices (timed out)'));
    const { open, log } = setup(adb);
    expect(await open()).toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
  });
});
