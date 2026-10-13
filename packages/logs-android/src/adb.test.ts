import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AdbMissingError,
  isPackageName,
  isPid,
  isSerial,
  nodeAdb,
  parseDevices,
  resolveAdbPath,
} from './adb.js';
import { ADB_DEVICES_FIXTURE } from './testing/fixtures.js';

describe('validation', () => {
  it('accepts emulator, USB and network serials only', () => {
    for (const s of ['emulator-5554', 'R58M123ABC', '192.168.1.20:5555', 'adb-XYZ._adb-tls._tcp'])
      expect(isSerial(s)).toBe(true);
    for (const s of ['', '-s', 'a b', 'a;rm', '$(id)', 'x'.repeat(65), 'a\nb'])
      expect(isSerial(s)).toBe(false);
  });

  it('accepts positive integer pids only', () => {
    expect(isPid(4242)).toBe(true);
    for (const p of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])
      expect(isPid(p)).toBe(false);
  });

  it('accepts Android package names only', () => {
    expect(isPackageName('com.example.shop')).toBe(true);
    expect(isPackageName('com.example.shop_2')).toBe(true);
    for (const n of ['shop', '1com.example', 'com..example', 'com.example;id', 'com.example:svc'])
      expect(isPackageName(n)).toBe(false);
  });
});

describe('parseDevices', () => {
  it('keeps devices that are online and have a valid serial', () => {
    expect(parseDevices(ADB_DEVICES_FIXTURE)).toEqual(['emulator-5554', 'R58M123ABC']);
  });

  it('ignores daemon start-up chatter, CRLF and bad serials', () => {
    const out =
      '* daemon not running; starting now at tcp:5037\r\n* daemon started successfully\r\n' +
      'List of devices attached\r\nemulator-5556\tdevice\r\nbad;serial\tdevice\r\n';
    expect(parseDevices(out)).toEqual(['emulator-5556']);
  });
});

describe('resolveAdbPath', () => {
  const none = (): boolean => false;

  it('prefers ANDROID_HOME, then ANDROID_SDK_ROOT', () => {
    const exists = (p: string): boolean => p.startsWith('/sdk');
    expect(
      resolveAdbPath({ ANDROID_HOME: '/sdk1', ANDROID_SDK_ROOT: '/sdk2' }, 'darwin', '/h', exists),
    ).toBe(join('/sdk1', 'platform-tools', 'adb'));
    expect(resolveAdbPath({ ANDROID_SDK_ROOT: '/sdk2' }, 'darwin', '/h', exists)).toBe(
      join('/sdk2', 'platform-tools', 'adb'),
    );
  });

  it("falls back to Android Studio's default SDK, then to adb on the PATH", () => {
    const studio = join('/h', 'Library', 'Android', 'sdk', 'platform-tools', 'adb');
    expect(resolveAdbPath({}, 'darwin', '/h', (p) => p === studio)).toBe(studio);
    expect(resolveAdbPath({}, 'darwin', '/h', none)).toBe('adb');
  });

  it('uses adb.exe under LOCALAPPDATA on Windows', () => {
    const studio = join(
      'C:\\Users\\me\\AppData\\Local',
      'Android',
      'Sdk',
      'platform-tools',
      'adb.exe',
    );
    expect(
      resolveAdbPath(
        { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
        'win32',
        '/h',
        (p) => p === studio,
      ),
    ).toBe(studio);
  });
});

// Runs Node in place of adb so the real spawn path is exercised without the Android SDK.
describe('nodeAdb', () => {
  const node = nodeAdb(process.execPath);

  it('runs a command without a shell and returns its stdout', async () => {
    expect(await node.exec(['-e', 'process.stdout.write(process.argv[1])', '$(echo hi);x'])).toBe(
      '$(echo hi);x',
    );
  });

  it('rejects when the command fails', async () => {
    await expect(node.exec(['-e', 'process.exit(3)'])).rejects.toThrow();
  });

  it('reports a missing binary as AdbMissingError', async () => {
    const missing = nodeAdb(join(import.meta.dirname, 'no-such-adb'));
    await expect(missing.exec(['version'])).rejects.toBeInstanceOf(AdbMissingError);
    const exit = await new Promise<Error | undefined>((resolve) => {
      missing.stream(['logcat'], { onData: () => undefined, onExit: resolve });
    });
    expect(exit).toBeInstanceOf(AdbMissingError);
  });

  it('streams stdout and stops the process when killed', async () => {
    const chunks: string[] = [];
    let stream: { kill(): void } | undefined;
    const exited = new Promise<Error | undefined>((resolve) => {
      stream = node.stream(
        ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'],
        {
          onData: (text) => {
            chunks.push(text);
            stream?.kill();
          },
          onExit: resolve,
        },
      );
    });
    expect(await exited).toBeUndefined();
    expect(chunks.join('')).toBe('ready\n');
  });
});
