import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeApp } from '@project-deck/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { XcrunRunner } from './ios.js';
import { resolveIosSource } from './ios.js';
import { plainDbFixture } from './testing/fixtures.js';

const UDID_A = '5B0B4F8E-1C2D-4E5F-8A9B-0C1D2E3F4A5B';
const UDID_B = '6C1C5A9F-2D3E-4F60-9BAC-1D2E3F4A5B6C';
const BUNDLE = 'com.example.shop';
let home: string;
let root: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'deck-ios-name-')));
  root = join(home, 'Library/Developer/CoreSimulator/Devices');
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function container(udid: string): string {
  const dir = join(
    root,
    udid,
    'data/Containers/Data/Application/0A1B2C3D-0000-4000-8000-000000000001',
  );
  mkdirSync(join(dir, 'Documents'), { recursive: true });
  writeFileSync(join(dir, 'Documents/app.sqlite'), plainDbFixture());
  return dir;
}

/** Booted simulators by UDID with their names, each with the app installed. */
function xcrun(sims: Record<string, string>): XcrunRunner {
  return {
    exec(args) {
      if (args.join(' ') === 'simctl list devices booted -j') {
        const devices = Object.entries(sims).map(([udid, name]) => ({
          udid,
          name,
          state: 'Booted',
        }));
        return Promise.resolve(JSON.stringify({ devices: { 'iOS-26-0': devices } }));
      }
      const udid = args[2] ?? '';
      return udid in sims
        ? Promise.resolve(`${container(udid)}\n`)
        : Promise.reject(new Error('2'));
    },
  };
}

/** connector-dart names the device from Flutter's app name; its id is always 'unknown'. */
const app = (deviceName: string) =>
  fakeApp({ name: 'shop', device: { id: 'unknown', name: deviceName, platform: 'ios' } });
const opts = () => ({ simulatorRoot: root, platform: 'darwin' as const });

describe("resolveIosSource with the connector's real device id (R5)", () => {
  it('refuses when the app runs on a device no booted simulator is named after', async () => {
    await expect(
      resolveIosSource(xcrun({ [UDID_A]: 'iPhone 17' }), app("Pat's iPhone"), BUNDLE, opts()),
    ).rejects.toMatchObject({
      code: 'unavailable',
      message: 'Snapshots work on the iOS simulator only.',
    });
  });

  it('uses the booted simulator whose name is the device name', async () => {
    const source = await resolveIosSource(
      xcrun({ [UDID_A]: 'iPad Air', [UDID_B]: 'iPhone 17' }),
      app('iPhone 17'),
      BUNDLE,
      opts(),
    );
    expect(source.label).toBe('iOS simulator iPhone 17');
  });

  it('asks the user to pick when two booted simulators share the name', async () => {
    await expect(
      resolveIosSource(
        xcrun({ [UDID_A]: 'iPhone 17', [UDID_B]: 'iPhone 17' }),
        app('iPhone 17'),
        BUNDLE,
        opts(),
      ),
    ).rejects.toMatchObject({ code: 'choose-device' });
  });
});
