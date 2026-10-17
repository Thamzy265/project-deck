import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeApp } from '@project-deck/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { XcrunRunner } from './ios.js';
import { IOS_TIMEOUTS, XCRUN_PATH, nodeXcrun, resolveIosSource } from './ios.js';
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
  fakeApp({ name: 'shop', device: { id: 'unknown', name: 'iPhone 17', platform: 'ios' }, ...over });

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'deck-ios-')));
  root = join(home, 'Library/Developer/CoreSimulator/Devices');
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const opts = () => ({ simulatorRoot: root, platform: 'darwin' as const });

describe('resolveIosSource', () => {
  it('finds the booted simulator with the app and runs only fixed xcrun commands', async () => {
    const dir = container(UDID_A);
    writeFileSync(join(dir, 'Documents/app.sqlite'), plainDbFixture());
    const xcrun = new FakeXcrun([UDID_A, UDID_B], { [UDID_A]: dir });
    const source = await resolveIosSource(xcrun, iosApp(), BUNDLE, opts());
    expect(source.label).toBe('iOS simulator iPhone 17');
    expect(xcrun.calls).toEqual([
      { args: ['simctl', 'list', 'devices', 'booted', '-j'], timeoutMs: IOS_TIMEOUTS.list },
      {
        args: ['simctl', 'get_app_container', UDID_A, BUNDLE, 'data'],
        timeoutMs: IOS_TIMEOUTS.container,
      },
      {
        args: ['simctl', 'get_app_container', UDID_B, BUNDLE, 'data'],
        timeoutMs: IOS_TIMEOUTS.container,
      },
    ]);
    expect(await source.list()).toEqual(['Documents/app.sqlite']);
    expect(await source.read('Documents/app.sqlite', 1e6)).toEqual(plainDbFixture());
    expect(await source.head('Documents/app.sqlite-wal', 32)).toBeUndefined();
  });

  it('asks the user to pick when two booted simulators have the app', async () => {
    const xcrun = new FakeXcrun([UDID_A, UDID_B], {
      [UDID_A]: container(UDID_A),
      [UDID_B]: container(UDID_B),
    });
    await expect(resolveIosSource(xcrun, iosApp(), BUNDLE, opts())).rejects.toMatchObject({
      code: 'choose-device',
    });
    // Unless the app says which simulator it runs on.
    const named = iosApp({ device: { id: UDID_B, name: 'iPhone 17', platform: 'ios' } });
    await expect(resolveIosSource(xcrun, named, BUNDLE, opts())).resolves.toBeDefined();
  });

  it('names the simulators to pick from, and uses the one the user chose', async () => {
    const xcrun = new FakeXcrun([UDID_A, UDID_B], {
      [UDID_A]: container(UDID_A),
      [UDID_B]: container(UDID_B),
    });
    const err: unknown = await resolveIosSource(xcrun, iosApp(), BUNDLE, opts()).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({
      code: 'choose-device',
      devices: [
        { id: UDID_A, name: 'iPhone 17' },
        { id: UDID_B, name: 'iPhone 17' },
      ],
    });
    const chosen = await resolveIosSource(xcrun, iosApp(), BUNDLE, { ...opts(), chosen: UDID_B });
    expect(chosen.containerReal).toBe(realpathSync(container(UDID_B)));
    // A choice that no longer has the app is not used: the user picks again.
    await expect(
      resolveIosSource(xcrun, iosApp(), BUNDLE, { ...opts(), chosen: UDID_A.replace('5B', '7D') }),
    ).rejects.toMatchObject({ code: 'choose-device' });
  });

  it('needs ios.bundleId, macOS and a booted simulator with the app', async () => {
    const xcrun = new FakeXcrun([UDID_A], {});
    await expect(resolveIosSource(xcrun, iosApp(), undefined, opts())).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining('ios.bundleId') as unknown,
    });
    await expect(
      resolveIosSource(xcrun, iosApp(), BUNDLE, { ...opts(), platform: 'linux' }),
    ).rejects.toMatchObject({
      code: 'unsupported',
    });
    await expect(resolveIosSource(xcrun, iosApp(), BUNDLE, opts())).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('skips simulator ids and bundle ids that are not the expected shape', async () => {
    const xcrun = new FakeXcrun(['../../etc', 'abc'], {});
    await expect(resolveIosSource(xcrun, iosApp(), BUNDLE, opts())).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(xcrun.calls).toHaveLength(1);
    await expect(resolveIosSource(xcrun, iosApp(), '-com.example', opts())).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('refuses a container outside the CoreSimulator devices folder', async () => {
    const outside = join(home, 'elsewhere');
    mkdirSync(join(outside, 'Documents'), { recursive: true });
    const xcrun = new FakeXcrun([UDID_A], { [UDID_A]: outside });
    await expect(resolveIosSource(xcrun, iosApp(), BUNDLE, opts())).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});

describe('IosSimulatorSource never follows links', () => {
  it('skips a linked file, and refuses to read through a linked folder or file', async () => {
    const dir = container(UDID_A);
    const secret = join(home, 'secret.db');
    writeFileSync(secret, plainDbFixture());
    symlinkSync(secret, join(dir, 'Documents/linked.db'));
    rmSync(join(dir, 'Library/Application Support'), { recursive: true });
    symlinkSync(home, join(dir, 'Library/Application Support'));
    const source = await resolveIosSource(
      new FakeXcrun([UDID_A], { [UDID_A]: dir }),
      iosApp(),
      BUNDLE,
      opts(),
    );
    expect(await source.list()).toEqual([]);
    await expect(source.read('Documents/linked.db', 1e6)).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(source.read('Library/Application Support/secret.db', 1e6)).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(source.read('../secret.db', 1e6)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('refuses a file over the cap without reading it', async () => {
    const dir = container(UDID_A);
    writeFileSync(join(dir, 'Documents/app.sqlite'), plainDbFixture());
    const source = await resolveIosSource(
      new FakeXcrun([UDID_A], { [UDID_A]: dir }),
      iosApp(),
      BUNDLE,
      opts(),
    );
    await expect(source.read('Documents/app.sqlite', 100)).rejects.toMatchObject({
      code: 'too-large',
    });
  });
});

describe('nodeXcrun', () => {
  it('runs /usr/bin/xcrun by its absolute path', () => {
    expect(XCRUN_PATH).toBe('/usr/bin/xcrun');
  });

  it('runs a command without a shell, with a timeout', { timeout: 15_000 }, async () => {
    const node = nodeXcrun(process.execPath);
    expect(await node.exec(['-e', 'process.stdout.write("ok")'], 10_000)).toBe('ok');
    await expect(node.exec(['-e', 'setInterval(() => {}, 1000)'], 300)).rejects.toThrow(
      /didn't answer/,
    );
    await expect(node.exec(['-e', 'process.exit(2)'], 10_000)).rejects.toThrow();
  });
});
