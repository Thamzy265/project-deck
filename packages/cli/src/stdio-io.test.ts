import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createStdIo } from './stdio-io.js';

const MAIN = fileURLToPath(new URL('../dist/main.js', import.meta.url));

function errnoError(code: string): Error {
  return Object.assign(new Error(`write ${code}`), { code });
}

describe('createStdIo', () => {
  it('survives EPIPE on stdout, drops later writes and does not count it as a failure', () => {
    const out = new PassThrough();
    const err = new PassThrough();
    const std = createStdIo(out, err);
    const seen: string[] = [];
    out.on('data', (d: Buffer) => seen.push(String(d)));
    std.io.out('one');
    out.emit('error', errnoError('EPIPE'));
    std.io.out('two');
    expect(std.failed()).toBe(false);
    expect(seen.join('')).toBe('one\n');
  });

  it('survives EPIPE on stderr too', () => {
    const out = new PassThrough();
    const err = new PassThrough();
    const std = createStdIo(out, err);
    err.emit('error', errnoError('EPIPE'));
    std.io.err('lost');
    expect(std.failed()).toBe(false);
  });

  it('reports other write errors on stderr and marks the run failed', () => {
    const out = new PassThrough();
    const err = new PassThrough();
    const std = createStdIo(out, err);
    const seen: string[] = [];
    err.on('data', (d: Buffer) => seen.push(String(d)));
    out.emit('error', errnoError('ENOSPC'));
    expect(std.failed()).toBe(true);
    expect(seen.join('')).toContain("Couldn't write output: write ENOSPC");
  });
});

describe('main.js with a closed stdout', () => {
  it.each([['--help'], ['--version'], ['bogus']])(
    '`%s` ends without a stack trace',
    async (arg) => {
      // stdout is a pipe whose reader is gone before the child writes.
      const child = spawn(process.execPath, [MAIN, arg], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: '' },
      });
      child.stdout.destroy();
      let stderr = '';
      child.stderr.on('error', () => undefined).on('data', (d: Buffer) => (stderr += String(d)));
      const [code] = (await once(child, 'close')) as [number | null];
      expect(stderr).not.toMatch(/EPIPE|at .*\.js:\d+/);
      expect(code).toBe(arg === 'bogus' ? 2 : 0);
    },
    20_000,
  );
});

describe('createStdIo flush', () => {
  it('waits for pending writes and sees a write error that arrives after the call', async () => {
    const out = new Writable({
      write: (_c, _e, cb) => setImmediate(() => cb(errnoError('EBADF'))),
    });
    const std = createStdIo(out, new PassThrough());
    std.io.out('last');
    expect(std.failed()).toBe(false);
    await std.flush();
    expect(std.failed()).toBe(true);
  });

  it('treats several queued writes after one EPIPE as one closed pipe, not a failure', async () => {
    const out = new Writable({
      write: (_c, _e, cb) => setImmediate(() => cb(errnoError('EPIPE'))),
    });
    const std = createStdIo(out, new PassThrough());
    for (const line of ['a', 'b', 'c']) std.io.out(line);
    await std.flush();
    expect(std.failed()).toBe(false);
  });

  it('does not hang when nothing is pending', async () => {
    await createStdIo(new PassThrough(), new PassThrough()).flush();
  });
});

describe('main.js mcp usage output with a closed stdout', () => {
  // `mcp --help` never serves, so it keeps the guard (R1 of the review).
  it('`mcp --help` ends without a stack trace', async () => {
    const child = spawn(process.execPath, [MAIN, 'mcp', '--help'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '' },
    });
    child.stdout.destroy();
    let stderr = '';
    child.stderr.on('error', () => undefined).on('data', (d: Buffer) => (stderr += String(d)));
    const [code] = (await once(child, 'close')) as [number | null];
    expect(stderr).not.toMatch(/EPIPE|at .*\.js:\d+/);
    expect(code).toBe(0);
  }, 20_000);
});

describe('createStdIo report and release', () => {
  it('flush waits for the "Couldn\'t write output" report on stderr', async () => {
    const out = new Writable({ write: (_c, _e, cb) => cb(errnoError('EBADF')) });
    const seen: string[] = [];
    const err = new Writable({
      write: (c, _e, cb) => setImmediate(() => (seen.push(String(c)), cb())),
    });
    const std = createStdIo(out, err);
    std.io.out('x');
    await std.flush();
    expect(seen.join('')).toContain("Couldn't write output");
  });

  it('release removes both listeners and writes raw afterwards', () => {
    const out = new PassThrough();
    const err = new PassThrough();
    const std = createStdIo(out, err);
    expect(out.listenerCount('error')).toBe(1);
    expect(err.listenerCount('error')).toBe(1);
    std.release();
    expect(out.listenerCount('error')).toBe(0);
    expect(err.listenerCount('error')).toBe(0);
    const seenOut: string[] = [];
    const seenErr: string[] = [];
    out.on('data', (d: Buffer) => seenOut.push(String(d)));
    err.on('data', (d: Buffer) => seenErr.push(String(d)));
    std.io.out('raw');
    std.io.err('raw err');
    expect(seenOut.join('')).toBe('raw\n');
    expect(seenErr.join('')).toBe('raw err\n');
  });
});
