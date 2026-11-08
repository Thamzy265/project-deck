/**
 * The real `Io`, over stdout and stderr. A reader that closes early (`start | head -1`)
 * makes the next write fail with EPIPE; without an 'error' listener that is an unhandled
 * error and a stack trace.
 */
import type { Io } from './io.js';
import { messageOf } from './io.js';

/** The part of a Node stream this needs; `process.stdout` fits. */
export interface OutStream {
  write: (chunk: string) => unknown;
  on: (event: 'error', listener: (err: Error) => void) => unknown;
}

export interface StdIo {
  io: Io;
  /** True once a write failed for a reason other than a closed pipe. */
  failed: () => boolean;
}

export function createStdIo(stdout: OutStream, stderr: OutStream): StdIo {
  let failed = false;
  const closed = { out: false, err: false };

  const guard = (stream: OutStream, name: 'out' | 'err'): void => {
    stream.on('error', (err: Error) => {
      closed[name] = true;
      // A closed pipe is the reader's choice, like `head`: end quietly, keep the command's
      // own exit code. Anything else (disk full, bad descriptor) is a real failure.
      if ((err as NodeJS.ErrnoException).code === 'EPIPE') return;
      failed = true;
      // stderr is the only place left to say so; if stderr itself broke, nothing is.
      if (name === 'out' && !closed.err) stderr.write(`Couldn't write output: ${messageOf(err)}\n`);
    });
  };
  guard(stdout, 'out');
  guard(stderr, 'err');

  return {
    io: {
      out: (line) => {
        if (!closed.out) stdout.write(`${line}\n`);
      },
      err: (line) => {
        if (!closed.err) stderr.write(`${line}\n`);
      },
    },
    failed: () => failed,
  };
}
