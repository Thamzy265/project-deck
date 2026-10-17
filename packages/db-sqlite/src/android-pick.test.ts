/**
 * Review R2: a device the user picks is used only for this app. Pids repeat across
 * devices, so the process at the app's pid on the picked device may be another
 * debuggable app, whose database must never be copied.
 */
import {
  FIXTURE_PACKAGE,
  FIXTURE_PID,
  FIXTURE_SERIAL,
  FakeAdb,
} from '@project-deck/android-adb/testing';
import { fakeApp } from '@project-deck/core/testing';
import { describe, expect, it } from 'vitest';
import { resolveAndroidSource } from './android.js';

const device = { id: 'unknown', name: 'Android device', platform: 'android' } as const;
const app = () => fakeApp({ name: FIXTURE_PACKAGE, pid: FIXTURE_PID, device });

/** The app on the emulator; on the phone, `process` at the same pid. */
const adbWith = (process: string) =>
  new FakeAdb({
    processes: {
      [FIXTURE_SERIAL]: { [FIXTURE_PID]: 'com.unrelated.game' },
      R58M123ABC: { [FIXTURE_PID]: process },
    },
  });

describe('resolveAndroidSource: the device the user picked (review R2)', () => {
  it('refuses another package at the pid on the picked device', async () => {
    const err: unknown = await resolveAndroidSource(
      adbWith('com.other.bank'),
      app(),
      FIXTURE_PACKAGE,
      'R58M123ABC',
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'unavailable' });
    expect((err as Error).message).toMatch(/isn't this app/);
  });

  it('takes a flavor of the app (its id plus a suffix), also in a :remote process', async () => {
    const flavor = await resolveAndroidSource(
      adbWith(`${FIXTURE_PACKAGE}.dev`),
      app(),
      FIXTURE_PACKAGE,
      'R58M123ABC',
    );
    expect(flavor.packageName).toBe(`${FIXTURE_PACKAGE}.dev`);
    const remote = await resolveAndroidSource(
      adbWith(`${FIXTURE_PACKAGE}.dev:remote`),
      app(),
      FIXTURE_PACKAGE,
      'R58M123ABC',
    );
    expect(remote.packageName).toBe(`${FIXTURE_PACKAGE}.dev`);
  });

  it('never takes an id that only starts with the same letters', async () => {
    await expect(
      resolveAndroidSource(
        adbWith(`${FIXTURE_PACKAGE}extra`),
        app(),
        FIXTURE_PACKAGE,
        'R58M123ABC',
      ),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });
});
