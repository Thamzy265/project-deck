/**
 * The real `Io`, over stdout and stderr. A reader that closes early (`start | head -1`)
 * makes the next write fail with EPIPE; without an 'error' listener that is an unhandled
 * error and a stack trace.
 */
import type { Io } from './io.js';
import { messageOf } from './io.js';

/** The part of a Node stream this needs; `process.stdout` fits. */
export interface OutStream {
  write: (chunk: string, callback: (err?: Error | null) => void) => unknown;
  on: (event: 'error', listener: (err: Error) => void) => unknown;
}

export interface StdIo {
  io: Io;
  /** True once a write failed for a reason other than a closed pipe. */
  failed: () => boolean;
  /**
   * Resolves when every write so far has finished, successfully or not. Node reports a
   * failed write only after the call returns, so check `failed()` after this, not before.
   */
  flush: () => Promise<void>;
}

/**
 * Only EPIPE means the reader went away. On win32 too: libuv translates a failed pipe
 * write (ERROR_BROKEN_PIPE, ERROR_NO_DATA) to EPIPE in uv_translate_write_sys_error
 * (src/win/error.c). EOF is only what its generic translation gives ERROR_BROKEN_PIPE on
 * reads, so a write that reports it stays visible.
 */
const CLOSED_READER = 'EPIPE';

export function createStdIo(stdout: OutStream, stderr: OutStream): StdIo {
  let failed = false;
  const closed = { out: false, err: false };
  let pending = 0;
  let idle: (() => void)[] = [];
  // A failed write reaches both its callback and the 'error' event: handle it once.
  const handled = new WeakSet<Error>();

  const onError = (name: 'out' | 'err', err: Error): void => {
    if (handled.has(err)) return;
    handled.add(err);
    closed[name] = true;
    // A closed pipe is the reader's choice, like `head`: end quietly, keep the command's
    // own exit code. Anything else (disk full, bad descriptor) is a real failure.
    if ((err as NodeJS.ErrnoException).code === CLOSED_READER) return;
    failed = true;
    // stderr is the only place left to say so; if stderr itself broke, nothing is.
    if (name === 'out' && !closed.err) {
      stderr.write(`Couldn't write output: ${messageOf(err)}\n`, () => undefined);
    }
  };

  const guard = (stream: OutStream, name: 'out' | 'err'): void => {
    stream.on('error', (err: Error) => onError(name, err));
  };
  guard(stdout, 'out');
  guard(stderr, 'err');

  const write = (stream: OutStream, name: 'out' | 'err', line: string): void => {
    if (closed[name]) return;
    pending += 1;
    stream.write(`${line}\n`, (err) => {
      // Writes queued before the stream failed are destroyed with it: that is the same
      // failure, already handled. A stream destroyed with no earlier error is new, so it
      // must not hide lost output.
      const destroyedAfterError =
        (err as NodeJS.ErrnoException | null | undefined)?.code === 'ERR_STREAM_DESTROYED' &&
        closed[name];
      if (err && !destroyedAfterError) onError(name, err);
      pending -= 1;
      if (pending === 0) {
        const waiting = idle;
        idle = [];
        for (const resolve of waiting) resolve();
      }
    });
  };

  return {
    io: {
      out: (line) => write(stdout, 'out', line),
      err: (line) => write(stderr, 'err', line),
    },
    failed: () => failed,
    flush: () => (pending === 0 ? Promise.resolve() : new Promise((r) => idle.push(r))),
  };
}
