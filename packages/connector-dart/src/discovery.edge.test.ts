import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPidFiles } from './discovery.js';

describe('readPidFiles edge cases', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'deck-dart-edge-'));
    await mkdir(join(home, 'dtd'), { recursive: true });
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const write = (name: string, content: unknown) =>
    writeFile(
      join(home, 'dtd', name),
      typeof content === 'string' ? content : JSON.stringify(content),
    );

  it('accepts file names with leading zeros and takes the pid from the content', async () => {
    await write('000123', { wsUri: 'ws://127.0.0.1:5000/a', pid: 123 });
    const isAlive = vi.fn(() => true);
    expect(await readPidFiles(home, isAlive)).toEqual([
      { wsUri: 'ws://127.0.0.1:5000/a', pid: 123, source: 'pid-file' },
    ]);
    expect(isAlive).toHaveBeenCalledWith(123);
  });

  it('handles huge numeric names and skips unsafe or non-positive pids without probing them', async () => {
    await write('99999999999999999999999', { wsUri: 'ws://127.0.0.1:5000/a', pid: 7 });
    await write('1', { wsUri: 'ws://127.0.0.1:5001/b', pid: 1e20 });
    await write('2', { wsUri: 'ws://127.0.0.1:5002/c', pid: 0 });
    await write('3', { wsUri: 'ws://127.0.0.1:5003/d', pid: -1 });
    await write('4', { wsUri: 'ws://127.0.0.1:5004/e', pid: 4.5 });
    await write('5', { wsUri: 'ws://127.0.0.1:5005/f', pid: '5' });
    const isAlive = vi.fn(() => true);
    expect((await readPidFiles(home, isAlive))?.map((d) => d.wsUri)).toEqual([
      'ws://127.0.0.1:5000/a',
    ]);
    // A negative pid would signal a whole process group; it must never reach process.kill.
    expect(isAlive.mock.calls).toEqual([[7]]);
  });

  it('ignores extra JSON fields and does not copy them through', async () => {
    await write('10', {
      wsUri: 'ws://localhost:5000/a',
      pid: 10,
      epoch: 1,
      workspaceRoot: '/x',
      secret: 'do-not-leak',
      ideName: 'VS Code',
    });
    expect(await readPidFiles(home, () => true)).toEqual([
      { wsUri: 'ws://localhost:5000/a', pid: 10, ideName: 'VS Code', source: 'pid-file' },
    ]);
  });

  it('accepts localhost, 127.0.0.1 and [::1] but not look-alike hosts', async () => {
    const uris = [
      'ws://localhost:5000/a',
      'ws://127.0.0.1:5001/b',
      'ws://[::1]:5002/c',
      'ws://localhost.evil.example:5003/d',
      'ws://127.0.0.2:5004/e',
      'ws://0.0.0.0:5005/f',
      'http://127.0.0.1:5006/g',
    ];
    for (const [i, wsUri] of uris.entries()) await write(String(i + 1), { wsUri, pid: i + 1 });
    const found = (await readPidFiles(home, () => true))?.map((d) => d.wsUri).sort();
    expect(found).toEqual(['ws://127.0.0.1:5001/b', 'ws://[::1]:5002/c', 'ws://localhost:5000/a']);
  });

  it('skips directories, empty files and JSON that is not an object', async () => {
    await mkdir(join(home, 'dtd', '20'));
    await write('21', '');
    await write('22', '[]');
    await write('23', 'null');
    await write('24', { wsUri: 'ws://127.0.0.1:5000/a', pid: 24 });
    expect((await readPidFiles(home, () => true))?.map((d) => d.pid)).toEqual([24]);
  });
});
