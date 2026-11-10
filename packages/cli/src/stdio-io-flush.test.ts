/**
 * flush() and the write callbacks of createStdIo, on fake streams whose callbacks the test
 * controls, plus one real Writable. No process, no network.
 */
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { OutStream } from './stdio-io.js';
import { createStdIo } from './stdio-io.js';

type Callback = (err?: Error | null) => void;

/** A stream that holds every write until the test calls `finish`. */
class HeldStream extends EventEmitter implements OutStream {
  readonly written: string[] = [];
  readonly callbacks: Callback[] = [];
  write(chunk: string, callback: Callback): boolean {
    this.written.push(chunk);
    this.callbacks.push(callback);
    return true;
  }
  finish(index: number, err?: Error): void {
    this.callbacks[index]?.(err ?? null);
  }
}

function errno(code: string): Error {
  return Object.assign(new Error(`write ${code}`), { code });
}

async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false;
  void promise.then(() => (done = true));
  await new Promise((r) => setImmediate(r));
  return done;
}

describe('createStdIo flush()', () => {
  it('resolves at once when nothing is pending', async () => {
    const std = createStdIo(new HeldStream(), new HeldStream());
    expect(await settled(std.flush())).toBe(true);
  });

  it('waits for a write whose callback has not fired, and never resolves on its own', async () => {
    // A reader that stops reading without closing leaves the callback pending: flush
    // follows the stream, it has no timeout of its own.
    const out = new HeldStream();
    const std = createStdIo(out, new HeldStream());
    std.io.out('stuck');
    const flushed = std.flush();
    expect(await settled(flushed)).toBe(false);
    out.finish(0);
    expect(await settled(flushed)).toBe(true);
  });

  it('resolves only after every pending write, on both streams', async () => {
    const out = new HeldStream();
    const err = new HeldStream();
    const std = createStdIo(out, err);
    std.io.out('a');
    std.io.out('b');
    std.io.err('c');
    const flushed = std.flush();
    out.finish(0);
    out.finish(1);
    expect(await settled(flushed)).toBe(false);
    err.finish(0);
    expect(await settled(flushed)).toBe(true);
  });

  it('resolves every waiting caller', async () => {
    const out = new HeldStream();
    const std = createStdIo(out, new HeldStream());
    std.io.out('a');
    const first = std.flush();
    const second = std.flush();
    out.finish(0);
    expect(await settled(first)).toBe(true);
    expect(await settled(second)).toBe(true);
  });

  it('works again for writes made after a flush', async () => {
    const out = new HeldStream();
    const std = createStdIo(out, new HeldStream());
    std.io.out('a');
    out.finish(0);
    await std.flush();
    std.io.out('b');
    const flushed = std.flush();
    expect(await settled(flushed)).toBe(false);
    out.finish(1);
    expect(await settled(flushed)).toBe(true);
    expect(out.written).toEqual(['a\n', 'b\n']);
  });

  it('resolves, quietly, when a pending write fails with EPIPE', async () => {
    const out = new HeldStream();
    const std = createStdIo(out, new HeldStream());
    std.io.out('a');
    const flushed = std.flush();
    out.finish(0, errno('EPIPE'));
    expect(await settled(flushed)).toBe(true);
    expect(std.failed()).toBe(false);
    std.io.out('dropped');
    expect(out.written).toEqual(['a\n']);
  });

  it('counts a failed write once when the callback and the error event both report it', async () => {
    const out = new HeldStream();
    const err = new HeldStream();
    const std = createStdIo(out, err);
    std.io.out('a');
    const failure = errno('EIO');
    out.finish(0, failure);
    out.emit('error', failure);
    // The report on stderr is a tracked write: flush waits for it.
    err.finish(0);
    await std.flush();
    expect(std.failed()).toBe(true);
    expect(err.written).toHaveLength(1);
    expect(err.written[0]).toContain("Couldn't write output: write EIO");
  });

  it('reports one failure when queued writes are destroyed after a non-EPIPE error', async () => {
    const out = new HeldStream();
    const err = new HeldStream();
    const std = createStdIo(out, err);
    std.io.out('a');
    std.io.out('b');
    std.io.out('c');
    out.finish(0, errno('EIO'));
    out.finish(1, errno('ERR_STREAM_DESTROYED'));
    out.finish(2, errno('ERR_STREAM_DESTROYED'));
    err.finish(0);
    await std.flush();
    expect(std.failed()).toBe(true);
    expect(err.written).toHaveLength(1);
  });

  it('keeps queued writes destroyed after an EPIPE quiet', async () => {
    const out = new HeldStream();
    const std = createStdIo(out, new HeldStream());
    std.io.out('a');
    std.io.out('b');
    out.finish(0, errno('EPIPE'));
    out.finish(1, errno('ERR_STREAM_DESTROYED'));
    await std.flush();
    expect(std.failed()).toBe(false);
  });

  it('stays quiet and does not hang when stderr is the failing stream', async () => {
    const err = new HeldStream();
    const std = createStdIo(new HeldStream(), err);
    std.io.err('a');
    err.finish(0, errno('EIO'));
    await std.flush();
    expect(std.failed()).toBe(true);
    expect(err.written).toEqual(['a\n']);
  });
});

describe('createStdIo on a real Writable', () => {
  it('a real Writable failing with EPIPE in its write callback ends quiet', async () => {
    const out = new Writable({ write: (_c, _e, cb) => cb(errno('EPIPE')) });
    const std = createStdIo(out, new PassThrough());
    std.io.out('one');
    std.io.out('two');
    await std.flush();
    std.io.out('three');
    await std.flush();
    expect(std.failed()).toBe(false);
  });
});
