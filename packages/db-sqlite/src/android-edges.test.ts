/**
 * Tester probes for the Android snapshot source: argument validation for the device
 * shell (design review S7) and which device and package are read when several are
 * connected ("FlutterDeck never guesses").
 * Tests marked `it.fails` (DB-n) are repros of open tester findings: they turn into
 * plain `it` tests when the fix lands.
 */
import type { AdbRunner } from '@project-deck/android-adb';
import { FIXTURE_PID, FakeAdb } from '@project-deck/android-adb/testing';
import { fakeApp } from '@project-deck/core/testing';
import { describe, expect, it } from 'vitest';
import { AndroidSource, resolveAndroidSource } from './android.js';
import { plainDbFixture } from './testing/fixtures.js';

const device = { id: 'unknown', name: 'Android device', platform: 'android' } as const;
const EMULATOR = 'emulator-5554';
const PHONE = 'R58M123ABC';
const TWO_DEVICES = `List of devices attached\n${PHONE}\tdevice\n${EMULATOR}\tdevice\n\n`;

describe('resolveAndroidSource with several devices (tester probes)', () => {
  it("DB-2: does not read another app's database when the pid is reused on another device", async () => {
    // Flutter reports the app's name ('shop'), not its package. The phone, listed first,
    // runs a different debuggable app at the same pid. config.json names the real id.
    const adb = new FakeAdb({
      devices: TWO_DEVICES,
      processes: {
        [PHONE]: { [FIXTURE_PID]: 'com.other.debugapp' },
        [EMULATOR]: { [FIXTURE_PID]: 'com.example.shop' },
      },
      files: {
        [PHONE]: { 'com.other.debugapp': { 'databases/other.db': plainDbFixture() } },
        [EMULATOR]: { 'com.example.shop': { 'databases/shop.db': plainDbFixture() } },
      },
    });
    const app = fakeApp({ name: 'shop', pid: FIXTURE_PID, device });
    const outcome = await resolveAndroidSource(adb, app, 'com.example.shop').then(
      (s) => `${s.serial}/${s.packageName}`,
      (err: unknown) => (err as { code?: string }).code,
    );
    expect(outcome).not.toBe(`${PHONE}/com.other.debugapp`);
    expect([`${EMULATOR}/com.example.shop`, 'choose-device']).toContain(outcome);
  });

  it('DB-2: asks the user to pick when two devices run a package at the pid and none is named', async () => {
    const adb = new FakeAdb({
      devices: TWO_DEVICES,
      processes: {
        [PHONE]: { [FIXTURE_PID]: 'com.other.debugapp' },
        [EMULATOR]: { [FIXTURE_PID]: 'com.example.shop' },
      },
    });
    const app = fakeApp({ name: 'shop', pid: FIXTURE_PID, device });
    await expect(resolveAndroidSource(adb, app, undefined)).rejects.toMatchObject({
      code: 'choose-device',
    });
  });

  it('uses the device whose process name is the app name when Flutter reports a package', async () => {
    const adb = new FakeAdb({
      devices: TWO_DEVICES,
      processes: {
        [PHONE]: { [FIXTURE_PID]: 'com.other.debugapp' },
        [EMULATOR]: { [FIXTURE_PID]: 'com.example.shop' },
      },
    });
    const app = fakeApp({ name: 'com.example.shop', pid: FIXTURE_PID, device });
    const source = await resolveAndroidSource(adb, app, undefined);
    expect([source.serial, source.packageName]).toEqual([EMULATOR, 'com.example.shop']);
  });

  it('refuses a process name that is not a plain package (a service process, a shell word)', async () => {
    for (const name of ['com.example.shop:remote', 'com.example.shop;id', 'sh', '-p']) {
      const adb = new FakeAdb({
        devices: `List of devices attached\n${EMULATOR}\tdevice\n\n`,
        processes: { [EMULATOR]: { [FIXTURE_PID]: name } },
      });
      const app = fakeApp({ name: 'shop', pid: FIXTURE_PID, device });
      const outcome = await resolveAndroidSource(adb, app, undefined).then(
        (s) => s.packageName,
        (err: unknown) => (err as { code?: string }).code,
      );
      expect(outcome, name).toBe('unavailable');
    }
  });
});

describe('AndroidSource argument checks (tester probes)', () => {
  const adb: AdbRunner = new FakeAdb();

  it('refuses serials the device shell or adb could misread', () => {
    for (const serial of [
      '',
      '-e',
      'emulator 5554',
      'emulator-5554;id',
      'emulator-5554\nid',
      'émulator-5554',
      'a'.repeat(65),
      '$(id)',
      '`id`',
    ]) {
      expect(() => new AndroidSource(adb, serial, 'com.example.shop'), serial).toThrow();
    }
  });

  it('refuses package names the device shell could misread', () => {
    for (const pkg of [
      '',
      'shop',
      'com',
      'com.example.shop ',
      'com.example shop',
      'com.example.shop\n',
      'com.example.shop;id',
      'com.example.$(id)',
      'com..shop',
      '.com.shop',
      'com.shop.',
      'com.exämple.shop',
      'com.example/../shop',
      '-com.example',
    ]) {
      expect(() => new AndroidSource(adb, EMULATOR, pkg), JSON.stringify(pkg)).toThrow();
    }
  });

  it('refuses file paths the device shell could misread, before running adb', async () => {
    const fake = new FakeAdb({ files: { [EMULATOR]: { 'com.example.shop': {} } } });
    const source = new AndroidSource(fake, EMULATOR, 'com.example.shop');
    for (const path of [
      'app_flutter/app.sqlite\nid',
      'app_flutter/app.sqlite;id',
      'app_flutter/$(id).db',
      'app_flutter/`id`.db',
      'app_flutter/app.sqlite -',
      'app_flutter/app.sqlite-shm',
      'app_flutter/app.sqlite-wal-wal',
      'app_flutter/.hidden.db',
      'app_flutter/ä.db',
      `app_flutter/${'a'.repeat(400)}.db`,
      'app_flutter//app.sqlite',
      'databases/../../../../etc/hosts.db',
      'Documents/app.sqlite',
      'app_flutter\\app.sqlite',
      'databases\\..\\x.db',
    ]) {
      await expect(source.read(path, 10), JSON.stringify(path)).rejects.toMatchObject({
        code: 'not-found',
      });
      await expect(source.head(path, 10), JSON.stringify(path)).rejects.toMatchObject({
        code: 'not-found',
      });
    }
    expect(fake.calls).toEqual([]);
  });

  it('passes a whole number of bytes to head -c, whatever it is given', async () => {
    const fake = new FakeAdb({
      files: { [EMULATOR]: { 'com.example.shop': { 'databases/a.db': plainDbFixture() } } },
    });
    const source = new AndroidSource(fake, EMULATOR, 'com.example.shop');
    await source.head('databases/a.db', 99.9);
    const [call] = fake.calls;
    expect(call?.slice(5)).toEqual(['head', '-c', '99', '--', 'databases/a.db']);
  });

  it('ignores ls lines that are not plain database names (CRLF, paths, option-like names)', async () => {
    const out = [
      'app.sqlite\r',
      '../escape.db',
      '-rf.db',
      'two words.db',
      'x.db;id',
      'app.sqlite-wal',
      'ok.db',
      '',
    ].join('\n');
    const runner: AdbRunner = {
      exec: () => Promise.resolve(out),
      execBinary: () => Promise.reject(new Error('unused')),
      stream: () => ({ kill: () => undefined }),
    };
    const source = new AndroidSource(runner, EMULATOR, 'com.example.shop');
    expect(await source.list()).toEqual([
      'app_flutter/app.sqlite',
      'app_flutter/ok.db',
      'databases/app.sqlite',
      'databases/ok.db',
    ]);
  });
});
