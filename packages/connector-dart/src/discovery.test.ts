import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dartDataHome, listViaDartCli, readPidFiles, toVmServiceWsUri } from './discovery.js';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

describe('dartDataHome', () => {
  it('follows DART_DATA_HOME, then the platform default', () => {
    expect(dartDataHome({ DART_DATA_HOME: '/custom' }, 'linux', '/home/u')).toBe('/custom');
    expect(dartDataHome({}, 'darwin', '/Users/u')).toBe(
      join('/Users/u', 'Library', 'Application Support', 'Dart'),
    );
    expect(dartDataHome({}, 'linux', '/home/u')).toBe(join('/home/u', '.local', 'state', 'Dart'));
    expect(dartDataHome({ XDG_STATE_HOME: '/xdg' }, 'linux', '/home/u')).toBe(join('/xdg', 'Dart'));
    expect(dartDataHome({ LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\U')).toBe(join('C:\\L', 'Dart'));
  });
});

describe('readPidFiles', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'deck-dart-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const write = async (name: string, content: unknown) => {
    await mkdir(join(home, 'dtd'), { recursive: true });
    await writeFile(
      join(home, 'dtd', name),
      typeof content === 'string' ? content : JSON.stringify(content),
    );
  };

  it('returns undefined when the directory does not exist', async () => {
    expect(await readPidFiles(home)).toBeUndefined();
  });

  it('keeps live loopback entries and skips stale, foreign and malformed ones', async () => {
    const entry = (pid: number, wsUri = 'ws://127.0.0.1:5000/abc') => ({
      wsUri,
      epoch: 1,
      pid,
      dartVersion: '3.12.2 (stable)',
      workspaceRoot: '/sdk',
      ideName: 'Android Studio',
    });
    await write('100', entry(100));
    await write('200', entry(200)); // dead
    await write('300', entry(300, 'ws://203.0.113.9:5000/abc')); // not loopback
    await write('400', 'not json');
    await write('notes.txt', entry(100));
    const result = await readPidFiles(home, (pid) => pid !== 200);
    expect(result).toEqual([
      {
        wsUri: 'ws://127.0.0.1:5000/abc',
        pid: 100,
        ideName: 'Android Studio',
        dartVersion: '3.12.2 (stable)',
        source: 'pid-file',
      },
    ]);
  });
});

describe('listViaDartCli', () => {
  // `dart tooling-daemon --list --machine` on Dart 3.12.2 (macOS), address masked.
  const REAL_OUTPUT =
    '[{"wsUri":"ws://127.0.0.1:52011/MASKED=","epoch":1790934391303,"pid":21624,' +
    '"dartVersion":"3.12.2 (stable) (Tue Jun 9 01:11:39 2026 -0700) on \\"macos_arm64\\"",' +
    '"workspaceRoot":"/Users/u/flutter/bin/cache/dart-sdk","ideName":"Android Studio"}]\n';

  it('parses the real output of the SDK', async () => {
    const calls: [string, string[]][] = [];
    const result = await listViaDartCli((file, args) => {
      calls.push([file, args]);
      return Promise.resolve(REAL_OUTPUT);
    });
    expect(calls).toEqual([['dart', ['tooling-daemon', '--list', '--machine']]]);
    expect(result).toEqual([
      {
        wsUri: 'ws://127.0.0.1:52011/MASKED=',
        pid: 21624,
        ideName: 'Android Studio',
        dartVersion: '3.12.2 (stable) (Tue Jun 9 01:11:39 2026 -0700) on "macos_arm64"',
        source: 'dart-cli',
      },
    ]);
  });

  it('keeps valid loopback entries and skips the rest one by one', async () => {
    const result = await listViaDartCli(() =>
      Promise.resolve(
        JSON.stringify([
          { wsUri: 'ws://127.0.0.1:6000/x', pid: 1 },
          { wsUri: 'ws://localhost:6001/y', pid: 'not a number' },
          { uri: 'ws://localhost:6002/z' },
          { wsUri: 'ws://8.8.8.8:1/z' },
          { wsUri: 'ws://[::1]:6003/w' },
        ]),
      ),
    );
    expect(result.map((r) => r.wsUri)).toEqual(['ws://127.0.0.1:6000/x', 'ws://[::1]:6003/w']);
  });

  it('returns nothing when dart is missing or prints garbage', async () => {
    expect(await listViaDartCli(() => Promise.reject(new Error('ENOENT')))).toEqual([]);
    expect(await listViaDartCli(() => Promise.resolve('Usage: ...'))).toEqual([]);
    expect(await listViaDartCli(() => Promise.resolve('{"wsUri":"ws://127.0.0.1:1/x"}'))).toEqual(
      [],
    );
  });
});

describe('toVmServiceWsUri', () => {
  it('converts the http form printed by flutter run', () => {
    expect(toVmServiceWsUri('http://127.0.0.1:5555/AbC=/')).toBe('ws://127.0.0.1:5555/AbC=/ws');
    expect(toVmServiceWsUri('ws://127.0.0.1:5555/AbC=/ws')).toBe('ws://127.0.0.1:5555/AbC=/ws');
    expect(toVmServiceWsUri('ws://127.0.0.1:5555/AbC=/ws/')).toBe('ws://127.0.0.1:5555/AbC=/ws');
  });

  it('returns undefined instead of throwing for an unparseable address', () => {
    expect(toVmServiceWsUri('not a uri')).toBeUndefined();
    expect(toVmServiceWsUri('')).toBeUndefined();
  });
});

describe('listViaDartCli default exec', () => {
  it('runs dart from the home directory, never the current one', async () => {
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _opts: object, cb: (err: null, stdout: string) => void) => {
        cb(null, '[]');
      },
    );
    expect(await listViaDartCli()).toEqual([]);
    expect(execFileMock).toHaveBeenCalledWith(
      'dart',
      ['tooling-daemon', '--list', '--machine'],
      expect.objectContaining({ cwd: homedir() }),
      expect.any(Function),
    );
  });
});
