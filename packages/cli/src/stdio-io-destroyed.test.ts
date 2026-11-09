/** Repro: a stream destroyed without an EPIPE must not lose output silently. */
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createStdIo } from './stdio-io.js';

describe('createStdIo with a stream destroyed for another reason', () => {
  // Repro: ERR_STREAM_DESTROYED is meant to be quiet only as the tail of an EPIPE. A
  // stream destroyed without any error loses every later write silently, exit 0.
  it('does not hide output lost to a stream destroyed without an EPIPE', async () => {
    const out = new PassThrough();
    const std = createStdIo(out, new PassThrough());
    out.destroy();
    std.io.out('lost');
    await std.flush();
    expect(std.failed()).toBe(true);
  });
});
