/**
 * Tester probes for the iOS simulator source: which device is read, and what a
 * simulator app could plant in its own container (design review S7).
 * Tests marked `it.fails` (DB-n) are repros of open tester findings: they turn into
 * plain `it` tests when the fix lands.
 */
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeApp } from '@project-deck/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { XcrunRunner } from './ios.js';
import { SqliteSnapshotFactory } from './factory.js';
import { nodeXcrun, resolveIosSource } from './ios.js';
import { plainDbFixture } from './testing/fixtures.js';

const UDID_A = '5B0B4F8E-1C2D-4E5F-8A9B-0C1D2E3F4A5B';
const UDID_B = '6C1C5A9F-2D3E-4F60-9BAC-1D2E3F4A5B6C';
const BUNDLE = 'com.example.shop';

let home: string;
let root: string;

/** `xcrun simctl list devices booted -j` as Xcode 26 prints it, trimmed. */
function list(udids: string[]): string {
  return JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-0': udids.map((udid) => ({
        udid,
        state: 'Booted',
        name: 'iPhone 17',
        isAvailable: true,
      })),
    },
  });
}

function container(udid: string): string {
  const dir = join(
    root,
    udid,
    'data/Containers/Data/Application/0A1B2C3D-0000-4000-8000-000000000001',
  );
  mkdirSync(join(dir, 'Documents'), { recursive: true });
  mkdirSync(join(dir, 'Library/Application Support'), { recursive: true });
  return dir;
}

class FakeXcrun implements XcrunRunner {
  readonly calls: { args: readonly string[]; timeoutMs: number }[] = [];
  constructor(
    private readonly booted: string[],
    private readonly containers: Record<string, string>,
  ) {}
  exec(args: readonly string[], timeoutMs: number): Promise<string> {
    this.calls.push({ args, timeoutMs });
    if (args.join(' ') === 'simctl list devices booted -j')
      return Promise.resolve(list(this.booted));
    const [simctl, cmd, udid, bundle, kind] = args;
    if (
      simctl === 'simctl' &&
      cmd === 'get_app_container' &&
      kind === 'data' &&
      bundle === BUNDLE
    ) {
      const dir = this.containers[udid ?? ''];
      return dir === undefined ? Promise.reject(new Error('exit 2')) : Promise.resolve(`${dir}\n`);
    }
    return Promise.reject(new Error(`unexpected ${args.join(' ')}`));
  }
}

const iosApp = (over: { device?: { id: string; name: string; platform: 'ios' } } = {}) =>
  fakeApp({ name: 'shop', device: { id: 'x', name: 'iPhone 17', platform: 'ios' }, ...over });

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'deck-ios-')));
  root = join(home, 'Library/Developer/CoreSimulator/Devices');
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const opts = () => ({ simulatorRoot: root, platform: 'darwin' as const });

describe('resolveIosSource: which device the app runs on (tester probes)', () => {
  it.fails(
    'DB-3: does not read a booted simulator when the app runs on a physical iPhone',
    async () => {
      // Flutter names a physical iPhone by its 25-character device id; a simulator by its
      // 36-character UDID. The same app is also installed on a booted simulator.
      const dir = container(UDID_A);
      writeFileSync(join(dir, 'Documents/app.sqlite'), plainDbFixture());
      const xcrun = new FakeXcrun([UDID_A], { [UDID_A]: dir });
      const onPhone = iosApp({
        device: { id: '00008110-000A1C2E3E91801E', name: "Pat's iPhone", platform: 'ios' },
      });
      const outcome = await resolveIosSource(xcrun, onPhone, BUNDLE, opts()).then(
        (s) => `read ${s.label}`,
        (err: unknown) => (err as { code?: string }).code,
      );
      expect(outcome).not.toBe('read iOS simulator iPhone 17');
    },
  );

  it('uses the simulator the app names even when another booted one has the app', async () => {
    const xcrun = new FakeXcrun([UDID_A, UDID_B], {
      [UDID_A]: container(UDID_A),
      [UDID_B]: container(UDID_B),
    });
    const named = iosApp({ device: { id: UDID_A, name: 'iPhone 17', platform: 'ios' } });
    const source = await resolveIosSource(xcrun, named, BUNDLE, opts());
    expect(source.label).toBe('iOS simulator iPhone 17');
  });

  it('refuses a container path that is relative, or has several lines', async () => {
    for (const out of ['relative/path', `${container(UDID_A)}\n/etc`]) {
      const xcrun = new FakeXcrun([UDID_A], { [UDID_A]: out });
      await expect(resolveIosSource(xcrun, iosApp(), BUNDLE, opts()), out).rejects.toMatchObject({
        code: 'unavailable',
      });
    }
  });

  it('refuses a container that is a link from inside the simulators folder to outside', async () => {
    const outside = join(home, 'elsewhere');
    mkdirSync(join(outside, 'Documents'), { recursive: true });
    writeFileSync(join(outside, 'Documents/app.sqlite'), plainDbFixture());
    const linked = join(root, UDID_A, 'linked-container');
    mkdirSync(join(root, UDID_A), { recursive: true });
    symlinkSync(outside, linked);
    const xcrun = new FakeXcrun([UDID_A], { [UDID_A]: linked });
    await expect(resolveIosSource(xcrun, iosApp(), BUNDLE, opts())).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('refuses bundle ids with spaces, a semicolon, a newline, unicode or over 155 characters', async () => {
    const xcrun = new FakeXcrun([UDID_A], { [UDID_A]: container(UDID_A) });
    for (const id of [
      'com.example shop',
      'com.example;id',
      'com.example\nshop',
      'com.ex\u00e4mple',
      `com.${'a'.repeat(160)}`,
      '',
    ]) {
      await expect(resolveIosSource(xcrun, iosApp(), id, opts()), id).rejects.toMatchObject({
        code: 'unavailable',
      });
    }
    expect(xcrun.calls).toEqual([]);
  });

  it('turns xcrun output that is not JSON, or JSON of another shape, into one message', async () => {
    for (const out of ['not json', '{"devices": 3}', '[]']) {
      const xcrun: XcrunRunner = { exec: () => Promise.resolve(out) };
      await expect(resolveIosSource(xcrun, iosApp(), BUNDLE, opts()), out).rejects.toMatchObject({
        code: 'unavailable',
        message: "Couldn't read the database: xcrun simctl list didn't answer.",
      });
    }
  });
});

describe('IosSimulatorSource: links the app could plant (tester probes)', () => {
  it.fails('DB-10: refuses a database file that is a hard link to a file elsewhere', async () => {
    // lstat can't tell a hard link from the file, but the link count can. A simulator
    // app could hard-link another SQLite file of the user's (same volume) into Documents.
    const dir = container(UDID_A);
    const elsewhere = join(home, 'other-app-history.db');
    writeFileSync(elsewhere, plainDbFixture());
    linkSync(elsewhere, join(dir, 'Documents/app.sqlite'));
    const source = await resolveIosSource(
      new FakeXcrun([UDID_A], { [UDID_A]: dir }),
      iosApp(),
      BUNDLE,
      opts(),
    );
    const outcome = await source.read('Documents/app.sqlite', 1e6).then(
      (b) => (b === undefined ? 'missing' : 'read the linked file'),
      (err: unknown) => (err as { code?: string }).code,
    );
    expect(outcome).not.toBe('read the linked file');
  });

  it('refuses a linked -wal or -journal next to a real database', async () => {
    const dir = container(UDID_A);
    writeFileSync(join(dir, 'Documents/app.sqlite'), plainDbFixture());
    const elsewhere = join(home, 'secret');
    writeFileSync(elsewhere, 'secret bytes');
    symlinkSync(elsewhere, join(dir, 'Documents/app.sqlite-wal'));
    symlinkSync(elsewhere, join(dir, 'Documents/app.sqlite-journal'));
    const source = await resolveIosSource(
      new FakeXcrun([UDID_A], { [UDID_A]: dir }),
      iosApp(),
      BUNDLE,
      opts(),
    );
    await expect(source.head('Documents/app.sqlite-wal', 32)).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(source.head('Documents/app.sqlite-journal', 28)).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('refuses names with .., a NUL, a leading dash or another folder, before touching disk', async () => {
    const dir = container(UDID_A);
    const source = await resolveIosSource(
      new FakeXcrun([UDID_A], { [UDID_A]: dir }),
      iosApp(),
      BUNDLE,
      opts(),
    );
    for (const name of [
      'Documents/../Documents/app.sqlite',
      'Documents/app\u0000.sqlite',
      'Documents/-app.sqlite',
      'Library/app.sqlite',
      'Library/Caches/app.sqlite',
      'tmp/app.sqlite',
      'Documents/sub/app.sqlite',
      '/Documents/app.sqlite',
    ]) {
      await expect(source.read(name, 1e6), name).rejects.toMatchObject({ code: 'not-found' });
    }
  });
});

describe('iOS snapshots outside macOS (tester probes)', () => {
  it('offers no iOS snapshot backend on Windows or Linux, and runs no xcrun there', async () => {
    for (const platform of ['win32', 'linux'] as const) {
      const xcrun = new FakeXcrun([UDID_A], { [UDID_A]: container(UDID_A) });
      const factory = new SqliteSnapshotFactory({
        platform,
        xcrun,
        ids: () => ({ iosBundleId: BUNDLE }),
      });
      expect(await factory.create(iosApp()), platform).toBeUndefined();
      expect(xcrun.calls).toEqual([]);
    }
  });
});

describe('nodeXcrun timeout (tester probes)', { timeout: 20_000 }, () => {
  it('DB-8: stops xcrun that ignores SIGTERM once its timeout passes', async () => {
    const pidFile = join(home, 'pid');
    const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
    try {
      const outcome = await Promise.race([
        nodeXcrun(process.execPath)
          .exec(['-e', script], 500)
          .then(
            () => 'resolved',
            () => 'rejected',
          ),
        new Promise<string>((r) => setTimeout(() => r('still waiting'), 6000)),
      ]);
      expect(outcome).toBe('rejected');
    } finally {
      try {
        process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  });
});
