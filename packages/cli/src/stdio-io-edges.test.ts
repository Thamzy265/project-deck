/**
 * Edge cases of the closed-pipe guard: unit tests on real Node streams, then the built
 * entrypoint as a process with stdout or stderr gone (`flutterdeck stop | head -1`).
 * Only fakes and scratch folders: no daemon is started, no network, no real HOME.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStdIo } from './stdio-io.js';

const MAIN = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const STACK = /EPIPE|node:events|at .*\.js:\d+|Unhandled/;

function errnoError(code: string): Error {
  return Object.assign(new Error(`write ${code}`), { code });
}

/** A real Writable whose write callback fails: Node turns that into an 'error' event. */
function failingWritable(code: string): Writable {
  return new Writable({ write: (_chunk, _enc, cb) => cb(errnoError(code)) });
}

function collect(stream: PassThrough): () => string {
  const seen: string[] = [];
  stream.on('data', (d: Buffer) => seen.push(String(d)));
  return () => seen.join('');
}

describe('createStdIo on real streams', () => {
  it('handles an EPIPE that comes from the write callback, then drops later writes', async () => {
    const out = failingWritable('EPIPE');
    const std = createStdIo(out, new PassThrough());
    std.io.out('one');
    // not events.once: it would reject on the 'error' event this test expects.
    await new Promise<void>((resolve) => out.on('close', resolve));
    // The stream is destroyed now; a second write must not throw or fail the run.
    expect(() => std.io.out('two')).not.toThrow();
    expect(std.failed()).toBe(false);
  });

  it('survives a second EPIPE event after the first', () => {
    const out = new PassThrough();
    const std = createStdIo(out, new PassThrough());
    out.emit('error', errnoError('EPIPE'));
    expect(() => out.emit('error', errnoError('EPIPE'))).not.toThrow();
    expect(std.failed()).toBe(false);
  });

  it('does not throw on a late write to a stream destroyed without an error, and reports it', async () => {
    const out = new PassThrough();
    const err = new PassThrough();
    const seenErr = collect(err);
    const std = createStdIo(out, err);
    out.destroy();
    // Node reports ERR_STREAM_DESTROYED only to the write callback, never as an event;
    // with no earlier failure that is lost output, not a closed pipe.
    expect(() => std.io.out('late')).not.toThrow();
    await std.flush();
    expect(std.failed()).toBe(true);
    expect(seenErr()).toContain("Couldn't write output");
  });

  it('EPIPE on stderr leaves stdout working', () => {
    const out = new PassThrough();
    const err = new PassThrough();
    const std = createStdIo(out, err);
    const seen = collect(out);
    err.emit('error', errnoError('EPIPE'));
    std.io.err('lost');
    std.io.out('kept');
    expect(seen()).toBe('kept\n');
    expect(std.failed()).toBe(false);
  });

  it('EPIPE on stdout leaves stderr working', () => {
    const out = new PassThrough();
    const err = new PassThrough();
    const std = createStdIo(out, err);
    const seen = collect(err);
    out.emit('error', errnoError('EPIPE'));
    std.io.out('lost');
    std.io.err('kept');
    expect(seen()).toBe('kept\n');
    expect(std.failed()).toBe(false);
  });

  it('a non-EPIPE error on stdout still reports on stderr when stderr is fine, and drops later stdout writes', () => {
    const out = new PassThrough();
    const err = new PassThrough();
    const std = createStdIo(out, err);
    const seenOut = collect(out);
    const seenErr = collect(err);
    out.emit('error', errnoError('EIO'));
    std.io.out('after');
    expect(std.failed()).toBe(true);
    expect(seenErr()).toContain("Couldn't write output: write EIO");
    expect(seenOut()).toBe('');
  });

  it('a non-EPIPE error on stdout is not reported on a closed stderr, but still fails the run', () => {
    const out = new PassThrough();
    const err = new PassThrough();
    const std = createStdIo(out, err);
    const seenErr = collect(err);
    err.emit('error', errnoError('EPIPE'));
    out.emit('error', errnoError('EIO'));
    expect(std.failed()).toBe(true);
    expect(seenErr()).toBe('');
  });

  it('a non-EPIPE error on stderr fails the run and does not loop', () => {
    const out = new PassThrough();
    const err = new PassThrough();
    const std = createStdIo(out, err);
    const seenErr = collect(err);
    err.emit('error', errnoError('EIO'));
    expect(std.failed()).toBe(true);
    // Nothing is written to the broken stream to say so.
    expect(seenErr()).toBe('');
    expect(() => std.io.err('later')).not.toThrow();
  });

  it('treats an error without a code as a real failure', () => {
    const out = new PassThrough();
    const err = new PassThrough();
    const std = createStdIo(out, err);
    const seenErr = collect(err);
    out.emit('error', new Error('boom'));
    expect(std.failed()).toBe(true);
    expect(seenErr()).toContain("Couldn't write output: boom");
  });

  it('does not treat EOF or ERR_STREAM_DESTROYED as a closed pipe', () => {
    // Only EPIPE is the reader's choice; anything else must stay visible.
    for (const code of ['EOF', 'ERR_STREAM_DESTROYED', 'ECONNRESET']) {
      const out = new PassThrough();
      const std = createStdIo(out, new PassThrough());
      out.emit('error', errnoError(code));
      expect(std.failed(), code).toBe(true);
    }
  });
});

describe('main.js with stdout or stderr gone', () => {
  let project: string;
  let home: string;

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'deck-cli-epipe-'));
    home = await mkdtemp(join(tmpdir(), 'deck-cli-epipe-home-'));
    await writeFile(
      join(project, 'pubspec.yaml'),
      'name: shop_app\ndependencies:\n  flutter:\n    sdk: flutter\n',
    );
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  interface Result {
    code: number | null;
    stdout: string;
    stderr: string;
  }

  /** Runs main.js; `gone` pipes have their reader destroyed before the child can write. */
  async function run(args: string[], gone: Array<'stdout' | 'stderr'>): Promise<Result> {
    const child = spawn(process.execPath, [MAIN, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // PATH empty: no tools found. No daemon is running in the scratch home or project.
      env: { HOME: home, USERPROFILE: home, PATH: '' },
    });
    const result: Result = { code: null, stdout: '', stderr: '' };
    for (const name of ['stdout', 'stderr'] as const) {
      if (gone.includes(name)) child[name].destroy();
      else
        child[name]
          .on('error', () => undefined)
          .on('data', (d: Buffer) => (result[name] += String(d)));
    }
    child.on('error', () => undefined);
    [result.code] = (await once(child, 'close')) as [number | null];
    return result;
  }

  it.each([['stop'], ['init']])(
    '`%s` with stdout gone ends quietly with its own exit code',
    async (cmd) => {
      const result = await run([cmd, '--project', project], ['stdout']);
      expect(result.stderr).not.toMatch(STACK);
      expect(result.code).toBe(0);
    },
    20_000,
  );

  it('`open` with stdout gone keeps its own exit code 1 and still says why on stderr', async () => {
    const result = await run(['open', '--project', project], ['stdout']);
    expect(result.stderr).toContain("isn't running");
    expect(result.stderr).not.toMatch(STACK);
    expect(result.code).toBe(1);
  }, 20_000);

  it('`stop` with stderr gone still prints its result on stdout', async () => {
    const result = await run(['stop', '--project', project], ['stderr']);
    expect(result.stdout).toContain("isn't running");
    expect(result.code).toBe(0);
  }, 20_000);

  it('a usage error with stderr gone keeps exit code 2 and no stack trace', async () => {
    const result = await run(['bogus'], ['stderr']);
    // stdout is untouched and empty; the failure is only in the exit code.
    expect(result.stdout).toBe('');
    expect(result.code).toBe(2);
  }, 20_000);

  it('`open` with both gone keeps exit code 1', async () => {
    const result = await run(['open', '--project', project], ['stdout', 'stderr']);
    expect(result.code).toBe(1);
  }, 20_000);

  it('`stop` with both gone exits 0', async () => {
    const result = await run(['stop', '--project', project], ['stdout', 'stderr']);
    expect(result.code).toBe(0);
  }, 20_000);
});
