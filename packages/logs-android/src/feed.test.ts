import type { LogEntry, RunningApp } from '@project-deck/core';
import { Registry } from '@project-deck/core';
import { describe, expect, it, vi } from 'vitest';
import type { AndroidLogFeedOptions } from './feed.js';
import { AndroidLogFeed } from './feed.js';
import { FakeAdb } from './testing/fake-adb.js';
import {
  FIXTURE_PACKAGE,
  FIXTURE_PID,
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
    await vi.waitFor(() => expect(entries).toHaveLength(11));
    expect(entries.every((e) => e.source === 'native')).toBe(true);
    expect(entries.at(-1)).toMatchObject({ level: 'fatal', tag: 'libc' });
    await close?.();
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
