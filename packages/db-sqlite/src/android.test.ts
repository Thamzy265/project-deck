import type { AdbRunner } from '@project-deck/android-adb';
import { AdbExitError, AdbMissingError, AdbTimeoutError } from '@project-deck/android-adb';
import {
  FIXTURE_PACKAGE,
  FIXTURE_PID,
  FIXTURE_SERIAL,
  FakeAdb,
} from '@project-deck/android-adb/testing';
import { fakeApp } from '@project-deck/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { AndroidSource, resolveAndroidSource } from './android.js';
import { plainDbFixture } from './testing/fixtures.js';

const device = { id: 'unknown', name: 'Android device', platform: 'android' } as const;
const androidApp = (over: { name?: string } = {}) =>
  fakeApp({ name: FIXTURE_PACKAGE, pid: FIXTURE_PID, device, ...over });
/** Before attach, or from a connector that can't tell, the pid is unknown. */
const appWithoutPid = () => fakeApp({ name: FIXTURE_PACKAGE, device });

function adbWith(files: Record<string, Buffer | string> | 'not-debuggable'): FakeAdb {
  return new FakeAdb({ files: { [FIXTURE_SERIAL]: { [FIXTURE_PACKAGE]: files } } });
}

describe('AndroidSource', () => {
  it('lists databases in app_flutter/ and databases/, skipping companions and other files', async () => {
    const adb = adbWith({
      'app_flutter/app.sqlite': plainDbFixture(),
      'app_flutter/app.sqlite-wal': Buffer.alloc(0),
      'app_flutter/flutter_assets.txt': 'x',
      'app_flutter/-evil.db': 'x',
      'databases/legacy.db': plainDbFixture(),
    });
    const source = new AndroidSource(adb, FIXTURE_SERIAL, FIXTURE_PACKAGE);
    expect(await source.list()).toEqual(['app_flutter/app.sqlite', 'databases/legacy.db']);
  });

  it('runs only fixed run-as commands, with the file after --, and the design timeouts', async () => {
    const adb = adbWith({ 'app_flutter/app.sqlite': plainDbFixture() });
    const exec = vi.spyOn(adb, 'exec');
    const execBinary = vi.spyOn(adb, 'execBinary');
    const source = new AndroidSource(adb, FIXTURE_SERIAL, FIXTURE_PACKAGE);
    await source.list();
    await source.head('app_flutter/app.sqlite', 100);
    await source.read('app_flutter/app.sqlite', 10_000);
    const runAs = ['-s', FIXTURE_SERIAL, 'exec-out', 'run-as', FIXTURE_PACKAGE];
    expect(exec.mock.calls).toEqual([
      [[...runAs, 'ls', '-1', 'app_flutter'], { timeoutMs: 10_000 }],
      [[...runAs, 'ls', '-1', 'databases'], { timeoutMs: 10_000 }],
    ]);
    expect(execBinary.mock.calls).toEqual([
      [
        [...runAs, 'head', '-c', '100', '--', 'app_flutter/app.sqlite'],
        { timeoutMs: 10_000, maxBytes: 4096 },
      ],
      [[...runAs, 'cat', '--', 'app_flutter/app.sqlite'], { timeoutMs: 60_000, maxBytes: 10_000 }],
    ]);
  });

  it('refuses names outside the fixed folders or with a bad file name, before running adb', async () => {
    const adb = adbWith({});
    const source = new AndroidSource(adb, FIXTURE_SERIAL, FIXTURE_PACKAGE);
    for (const path of [
      '../app.sqlite',
      'app_flutter/../x.db',
      'shared_prefs/x.db',
      'app_flutter/a b.db',
      'app_flutter/x.db; id',
      'app_flutter/-x.db',
    ]) {
      await expect(source.read(path, 10), path).rejects.toMatchObject({ code: 'not-found' });
    }
    // Companions of a valid name are allowed.
    await expect(source.head('app_flutter/app.sqlite-wal', 32)).resolves.toBeUndefined();
    expect(adb.calls).toHaveLength(1);
  });

  it('refuses a serial or package that could be read as an option or a command', () => {
    const adb = adbWith({});
    expect(() => new AndroidSource(adb, '-s', FIXTURE_PACKAGE)).toThrow();
    expect(() => new AndroidSource(adb, FIXTURE_SERIAL, 'com.example;id')).toThrow();
    expect(() => new AndroidSource(adb, FIXTURE_SERIAL, '-com.example')).toThrow();
  });

  it("says the app isn't debuggable, from stderr or from exec-out's merged output", async () => {
    const source = new AndroidSource(adbWith('not-debuggable'), FIXTURE_SERIAL, FIXTURE_PACKAGE);
    await expect(source.list()).rejects.toMatchObject({
      code: 'not-debuggable',
      message: "This app isn't debuggable, so Android won't let FlutterDeck copy its database.",
    });
    // exec-out on older adb puts run-as's complaint on stdout and exits 0.
    const merged: AdbRunner = {
      exec: () => Promise.resolve('run-as: package not debuggable: com.example.shop\n'),
      execBinary: () =>
        Promise.resolve(Buffer.from("run-as: Package 'com.example.shop' is not debuggable\n")),
      stream: () => ({ kill: () => undefined }),
    };
    const old = new AndroidSource(merged, FIXTURE_SERIAL, FIXTURE_PACKAGE);
    await expect(old.list()).rejects.toMatchObject({ code: 'not-debuggable' });
    await expect(old.read('app_flutter/app.sqlite', 100)).rejects.toMatchObject({
      code: 'not-debuggable',
    });
  });

  it('treats a missing file as missing, also when cat says so on stdout', async () => {
    const merged: AdbRunner = {
      exec: () => Promise.resolve(''),
      execBinary: () =>
        Promise.resolve(
          Buffer.from('cat: app_flutter/app.sqlite-wal: No such file or directory\n'),
        ),
      stream: () => ({ kill: () => undefined }),
    };
    const source = new AndroidSource(merged, FIXTURE_SERIAL, FIXTURE_PACKAGE);
    await expect(source.head('app_flutter/app.sqlite-wal', 32)).resolves.toBeUndefined();
  });

  it('reports adb failures with the command that failed, never device text', async () => {
    const fail = (err: Error): AdbRunner => ({
      exec: () => Promise.reject(err),
      execBinary: () => Promise.reject(err),
      stream: () => ({ kill: () => undefined }),
    });
    const timedOut = new AndroidSource(
      fail(new AdbTimeoutError(60_000)),
      FIXTURE_SERIAL,
      FIXTURE_PACKAGE,
    );
    await expect(timedOut.read('app_flutter/app.sqlite', 10)).rejects.toMatchObject({
      code: 'unavailable',
      message: "Couldn't read the database: adb didn't answer.",
    });
    const missing = new AndroidSource(
      fail(new AdbMissingError('/x/adb')),
      FIXTURE_SERIAL,
      FIXTURE_PACKAGE,
    );
    await expect(missing.list()).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining('adb') as unknown,
    });
    const other = new AndroidSource(
      fail(new AdbExitError(1, null, 'secret device text')),
      FIXTURE_SERIAL,
      FIXTURE_PACKAGE,
    );
    const err: unknown = await other.list().catch((e: unknown) => e);
    expect((err as Error).message).not.toContain('secret');
  });
});

describe('resolveAndroidSource', () => {
  it('finds the device by the app pid and uses the process name as the package', async () => {
    const source = await resolveAndroidSource(adbWith({}), androidApp(), undefined);
    expect(source.label).toBe(`Android ${FIXTURE_SERIAL}`);
    expect(source.packageName).toBe(FIXTURE_PACKAGE);
  });

  it('falls back to android.applicationId with one device when the pid is unknown', async () => {
    const adb = new FakeAdb({
      devices: `List of devices attached\n${FIXTURE_SERIAL}\tdevice\n\n`,
      files: { [FIXTURE_SERIAL]: { 'com.example.other': {} } },
    });
    const source = await resolveAndroidSource(adb, appWithoutPid(), 'com.example.other');
    expect(source.packageName).toBe('com.example.other');
  });

  it('asks the user to pick when several devices could run the app, and never guesses', async () => {
    await expect(
      resolveAndroidSource(new FakeAdb(), appWithoutPid(), FIXTURE_PACKAGE),
    ).rejects.toMatchObject({ code: 'choose-device' });
  });

  it('says what is missing without a device or an app id', async () => {
    await expect(
      resolveAndroidSource(
        new FakeAdb({ devices: 'List of devices attached\n\n' }),
        appWithoutPid(),
        FIXTURE_PACKAGE,
      ),
    ).rejects.toMatchObject({ code: 'unavailable' });
    await expect(
      resolveAndroidSource(new FakeAdb({ processes: {} }), androidApp({ name: 'shop' }), undefined),
    ).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining('android.applicationId') as unknown,
    });
    await expect(
      resolveAndroidSource(new FakeAdb({ missing: true }), androidApp(), undefined),
    ).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});
