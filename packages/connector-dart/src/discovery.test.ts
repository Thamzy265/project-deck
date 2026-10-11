import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dartDataHome, listViaDartCli, readPidFiles, toVmServiceWsUri } from './discovery.js';

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
  it('runs the fixed command and keeps loopback entries', async () => {
    const calls: [string, string[]][] = [];
    const result = await listViaDartCli((file, args) => {
      calls.push([file, args]);
      return Promise.resolve(
        JSON.stringify([
          { wsUri: 'ws://127.0.0.1:6000/x', pid: 1 },
          { uri: 'ws://localhost:6001/y' },
          { wsUri: 'ws://8.8.8.8:1/z' },
        ]),
      );
    });
    expect(calls).toEqual([['dart', ['tooling-daemon', '--list', '--machine']]]);
    expect(result.map((r) => r.wsUri)).toEqual(['ws://127.0.0.1:6000/x', 'ws://localhost:6001/y']);
  });

  it('returns nothing when dart is missing or prints garbage', async () => {
    expect(await listViaDartCli(() => Promise.reject(new Error('ENOENT')))).toEqual([]);
    expect(await listViaDartCli(() => Promise.resolve('Usage: ...'))).toEqual([]);
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
