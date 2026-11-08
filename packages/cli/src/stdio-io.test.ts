import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
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
      child.stderr.on('data', (d: Buffer) => (stderr += String(d)));
      const [code] = (await once(child, 'close')) as [number | null];
      expect(stderr).not.toMatch(/EPIPE|at .*\.js:\d+/);
      expect(code).toBe(arg === 'bogus' ? 2 : 0);
    },
    20_000,
  );
});
