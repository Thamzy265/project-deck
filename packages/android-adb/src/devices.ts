import type { AdbRunner } from './adb.js';
import { isPackageName, parseDevices, parsePsName } from './adb.js';

/** Before Android 8.0 (API 26), `ps` is toolbox, which has no `-o` or `-p <pid>`. */
const TOYBOX_PS_MIN_SDK = 26;

export interface AppDevice {
  serial: string;
  /** API level, or undefined when `getprop` couldn't say. */
  sdk: number | undefined;
  /** Process name at the pid, or '' when ps couldn't say. */
  process: string;
}

/** The device's API level, or undefined when it can't be read. */
export async function sdkLevel(adb: AdbRunner, serial: string): Promise<number | undefined> {
  try {
    const out = (await adb.exec(['-s', serial, 'shell', 'getprop', 'ro.build.version.sdk'])).trim();
    return /^\d{1,3}$/.test(out) ? Number(out) : undefined;
  } catch {
    return undefined;
  }
}

/** What runs at `pid` on the device ('' when unknown) and the device's API level. */
async function probe(adb: AdbRunner, serial: string, pid: number): Promise<AppDevice> {
  const sdk = await sdkLevel(adb, serial);
  // Toybox ps (API 26+) filters by pid; old toolbox ps takes the pid as an argument.
  const ps =
    sdk !== undefined && sdk < TOYBOX_PS_MIN_SDK
      ? ['ps', String(pid)]
      : ['ps', '-o', 'NAME=', '-p', String(pid)];
  const process = await adb
    .exec(['-s', serial, 'shell', ...ps])
    .then((out) => parsePsName(out, pid))
    .catch(() => '');
  return { serial, sdk, process };
}

/**
 * The online device running `pid`, with its API level and the process name there.
 * Pids are only unique per device, so ask each one what runs at that pid. Only a
 * process whose name is an Android package counts (a system process such as
 * `system_server` rules the device out), preferring the app's own package name. With
 * several devices and no name match the first package wins: a guess, so callers that
 * act on the result (rather than only read logs) must check the process name.
 * Rejects when `adb devices` fails, for example with AdbMissingError.
 */
export async function findDeviceForPid(
  adb: AdbRunner,
  pid: number,
  appName: string,
): Promise<AppDevice | undefined> {
  const serials = parseDevices(await adb.exec(['devices']));
  const devices = await Promise.all(serials.map((serial) => probe(adb, serial, pid)));
  const exact = isPackageName(appName) ? devices.find((d) => d.process === appName) : undefined;
  const only = devices.length === 1 ? devices[0] : undefined;
  return (
    exact ??
    devices.find((d) => isPackageName(d.process)) ??
    // ps gave no usable name at all (unsupported); with one device it must be that one.
    (only?.process === '' ? only : undefined)
  );
}
