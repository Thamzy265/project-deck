import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  AdbMissingError,
  isPackageName,
  isPid,
  isSerial,
  nodeAdb,
  parseDevices,
  parsePsName,
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
    const onPath = join('/opt/homebrew/bin', 'adb');
    expect(
      resolveAdbPath({ PATH: '/usr/bin:/opt/homebrew/bin' }, 'darwin', '/h', (p) => p === onPath),
    ).toBe(onPath);
    expect(resolveAdbPath({ PATH: '/usr/bin' }, 'darwin', '/h', none)).toBeUndefined();
  });

  it('ignores relative SDK variables, which would resolve against the cwd', () => {
    const anywhere = (): boolean => true;
    for (const sdk of ['sdk', '.', './sdk', '..']) {
      expect(
        resolveAdbPath({ ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk }, 'linux', '/h', anywhere),
      ).toBe(join('/h', 'Android', 'Sdk', 'platform-tools', 'adb'));
    }
    expect(
      resolveAdbPath({ LOCALAPPDATA: 'AppData', PATH: 'C:\\tools' }, 'win32', 'C:\\h', anywhere),
    ).toBe(join('C:\\tools', 'adb.exe'));
  });

  it('never resolves adb from the current directory or a relative PATH entry', () => {
    // Every candidate "exists", so only the PATH filtering decides.
    expect(
      resolveAdbPath({ PATH: '.::bin:./tools' }, 'linux', '/h', (p) => !p.includes('Sdk')),
    ).toBeUndefined();
    expect(
      resolveAdbPath({ PATH: '.:bin:/opt/bin' }, 'linux', '/h', (p) => !p.includes('Sdk')),
    ).toBe(join('/opt/bin', 'adb'));
  });

  it('walks a Windows PATH (either spelling) for adb.exe, skipping . and relative entries', () => {
    const notSdk = (p: string): boolean => !p.includes('Sdk');
    expect(
      resolveAdbPath({ PATH: '.;tools;C:\\platform-tools' }, 'win32', 'C:\\Users\\me', notSdk),
    ).toBe(join('C:\\platform-tools', 'adb.exe'));
    expect(resolveAdbPath({ Path: '.;C:\\platform-tools' }, 'win32', 'C:\\Users\\me', notSdk)).toBe(
      join('C:\\platform-tools', 'adb.exe'),
    );
    expect(resolveAdbPath({ PATH: '.;tools' }, 'win32', 'C:\\Users\\me', notSdk)).toBeUndefined();
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

describe('parseDevices edge cases', () => {
  it('never returns a serial that adb would read as an option', () => {
    const out = 'List of devices attached\n-s\tdevice\n--help\tdevice\n-\tdevice\nok-1\tdevice\n';
    expect(parseDevices(out)).toEqual(['ok-1']);
  });

  it('skips every state other than device', () => {
    const out = [
      'List of devices attached',
      'emulator-5554\tunauthorized',
      'emulator-5556\toffline',
      'R58M123ABC\trecovery',
      'R58M123ABD\tsideload',
      'R58M123ABE\tbootloader',
      'R58M123ABF\tno permissions (missing udev rules); see [http://developer.android.com/tools/device.html]',
      '192.168.1.5:5555\tdevice',
      '',
    ].join('\n');
    expect(parseDevices(out)).toEqual(['192.168.1.5:5555']);
  });

  it('rejects a serial carrying a newline or shell metacharacters', () => {
    expect(parseDevices('List of devices attached\nemu\rlator\tdevice\n')).toEqual([]);
    expect(parseDevices('List of devices attached\n$(reboot)\tdevice\n`id`\tdevice\n')).toEqual([]);
  });
});

describe('resolveAdbPath edge cases', () => {
  it('keeps an SDK path with spaces as one path', () => {
    const sdk = '/Users/me/Android SDK';
    const want = join(sdk, 'platform-tools', 'adb');
    expect(resolveAdbPath({ ANDROID_HOME: sdk }, 'darwin', '/h', (p) => p === want)).toBe(want);
  });

  it('skips an SDK without adb and tries the next one', () => {
    const want = join('/sdk2', 'platform-tools', 'adb');
    expect(
      resolveAdbPath(
        { ANDROID_HOME: '/sdk1', ANDROID_SDK_ROOT: '/sdk2' },
        'darwin',
        '/h',
        (p) => p === want,
      ),
    ).toBe(want);
  });

  it('uses ~/Android/Sdk on Linux and ignores empty variables', () => {
    const want = join('/home/me', 'Android', 'Sdk', 'platform-tools', 'adb');
    expect(
      resolveAdbPath(
        { ANDROID_HOME: '', ANDROID_SDK_ROOT: '' },
        'linux',
        '/home/me',
        (p) => p === want,
      ),
    ).toBe(want);
  });
});

describe('nodeAdb edge cases', () => {
  const node = nodeAdb(process.execPath);

  it('gives up on a command that hangs', async () => {
    const slow = nodeAdb(process.execPath, { timeoutMs: 200 });
    const started = Date.now();
    await expect(slow.exec(['-e', 'setInterval(() => {}, 1000)'])).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('rejects output over 1 MB instead of buffering it all', async () => {
    await expect(
      node.exec(['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024))']),
    ).rejects.toThrow();
  });

  it('decodes a UTF-8 character split across two writes', async () => {
    const chunks: string[] = [];
    const exit = await new Promise<Error | undefined>((resolve) => {
      node.stream(
        [
          '-e',
          // "é" is 0xC3 0xA9; send the bytes in separate writes with a pause between.
          'process.stdout.write(Buffer.from([0x63, 0x61, 0x66, 0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa9, 0x0a])), 50)',
        ],
        { onData: (t) => chunks.push(t), onExit: resolve },
      );
    });
    expect(exit).toBeUndefined();
    expect(chunks.join('')).toBe('café\n');
    expect(chunks.join('')).not.toContain('�');
  });

  it('reports a non-zero exit of a stream that ends on its own', async () => {
    const exit = await new Promise<Error | undefined>((resolve) => {
      node.stream(['-e', 'process.exit(1)'], { onData: () => undefined, onExit: resolve });
    });
    expect(exit?.message).toMatch(/code 1/);
  });

  it('calls onExit once and ignores kill after the process is gone', async () => {
    const onExit = vi.fn();
    let stream: { kill(): void } | undefined;
    await new Promise<void>((resolve) => {
      stream = node.stream(['-e', ''], {
        onData: () => undefined,
        onExit: (err) => {
          onExit(err);
          resolve();
        },
      });
    });
    stream?.kill();
    stream?.kill();
    await new Promise((r) => setTimeout(r, 20));
    expect(onExit).toHaveBeenCalledOnce();
    expect(onExit).toHaveBeenCalledWith(undefined);
  });

  it('can be killed before it prints anything, and the process is gone', async () => {
    const pidFile = join(tmpdir(), `deck-adb-kill-${process.pid}-${Date.now()}`);
    let stream: { kill(): void } | undefined;
    const exited = new Promise<Error | undefined>((resolve) => {
      stream = node.stream(
        [
          '-e',
          `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
        ],
        { onData: () => undefined, onExit: resolve },
      );
    });
    try {
      // A cold Node start on a busy CI machine can take seconds.
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 10_000 });
      const childPid = Number(readFileSync(pidFile, 'utf8'));
      stream?.kill();
      expect(await exited).toBeUndefined();
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      // Never leave the child running if an assertion above failed.
      stream?.kill();
      rmSync(pidFile, { force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('runs adb from a path with spaces', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deck adb '));
    try {
      const fake = join(dir, 'adb');
      symlinkSync(process.execPath, fake);
      expect(await nodeAdb(fake).exec(['-e', 'process.stdout.write("ok")'])).toBe('ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('nodeAdb safety', () => {
  it('runs adb in the home directory, not the current one', async () => {
    const cwd = await nodeAdb(process.execPath).exec(['-e', 'process.stdout.write(process.cwd())']);
    expect(cwd).toBe(realpathSync(homedir()));
  });

  it('reports adb as missing without running anything when it was not found', async () => {
    const none = nodeAdb(null);
    await expect(none.exec(['devices'])).rejects.toBeInstanceOf(AdbMissingError);
    const exit = await new Promise<Error | undefined>((resolve) => {
      none.stream(['logcat'], { onData: () => undefined, onExit: resolve });
    });
    expect(exit).toBeInstanceOf(AdbMissingError);
  });
});

describe('parsePsName', () => {
  it('reads toybox `ps -o NAME=` output', () => {
    expect(parsePsName('com.example.shop\r\n', 4242)).toBe('com.example.shop');
    expect(parsePsName('', 4242)).toBe('');
  });

  it('reads the NAME column of the row for the pid in toolbox output', () => {
    const out = [
      'USER      PID   PPID  VSIZE  RSS   WCHAN              PC  NAME',
      'u0_a85    4241  1234  1003924 98712 SyS_epoll_ 00000000 S com.other.app',
      'u0_a86    4242  1234  1003924 98712 SyS_epoll_ 00000000 S com.example.shop',
      '',
    ].join('\r\n');
    expect(parsePsName(out, 4242)).toBe('com.example.shop');
  });

  it('gives no name when toolbox prints only its header', () => {
    expect(parsePsName('USER PID PPID VSIZE RSS WCHAN PC NAME\n', 4242)).toBe('');
  });
});
