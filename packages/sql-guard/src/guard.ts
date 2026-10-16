import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import type { GuardCheckOptions, GuardResult } from './types.js';
import { GuardResultSchema, MAX_SQL_BYTES } from './types.js';

export interface SqlGuard {
  /**
   * Judges one statement (ADR 0005). Never rejects: a gate that can't answer refuses
   * (`unavailable` or `timeout`), so nothing unjudged reaches a database.
   */
  check(sql: string, opts: GuardCheckOptions): Promise<GuardResult>;
  /** Stops the worker. Later checks refuse with `unavailable`. */
  close(): Promise<void>;
}

export interface SqlGuardOptions {
  /** Loading the wasm engine (ADR 0005 amended: 10 s). */
  initTimeoutMs?: number;
  /** One check, including building a new schema's scratch database (amended: 1 s). */
  checkTimeoutMs?: number;
  /** Scratch databases kept, one per schema. */
  maxSchemas?: number;
  /** Test seam: the worker script. Defaults to the built worker next to this file. */
  workerUrl?: URL;
}

const ReplySchema = z.union([
  z.object({ ready: z.literal(true) }),
  z.object({ id: z.number(), result: GuardResultSchema }),
  z.object({ id: z.number(), failed: z.literal(true) }),
]);

const refusal = (code: 'unavailable' | 'timeout', reason: string): GuardResult => ({
  ok: false,
  code,
  reason,
});

/**
 * Creates the gate. The wasm engine loads lazily, on the first check, in a worker
 * thread; a check over its budget terminates that worker and the next check starts a
 * fresh one.
 */
export function createSqlGuard(opts: SqlGuardOptions = {}): SqlGuard {
  const initTimeoutMs = opts.initTimeoutMs ?? 10_000;
  const checkTimeoutMs = opts.checkTimeoutMs ?? 1000;
  const workerUrl = opts.workerUrl ?? new URL('./worker.js', import.meta.url);
  let live: Worker | undefined;
  let starting: Promise<Worker | undefined> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let nextId = 0;
  let closed = false;

  const discard = (w: Worker): void => {
    void w.terminate().catch(() => undefined);
  };

  const start = (): Promise<Worker | undefined> => {
    if (live !== undefined) return Promise.resolve(live);
    starting ??= new Promise<Worker | undefined>((resolve) => {
      let w: Worker;
      try {
        // No inherited flags: `--input-type` (node -e) or loaders would break the worker.
        w = new Worker(workerUrl, { workerData: { maxSchemas: opts.maxSchemas }, execArgv: [] });
      } catch {
        resolve(undefined);
        return;
      }
      w.unref();
      const done = (ok: boolean): void => {
        clearTimeout(timer);
        w.off('message', onMessage);
        if (ok && !closed) {
          live = w;
          resolve(w);
          return;
        }
        discard(w);
        resolve(undefined);
      };
      const onMessage = (raw: unknown): void => {
        const reply = ReplySchema.safeParse(raw);
        done(reply.success && 'ready' in reply.data);
      };
      const timer = setTimeout(() => done(false), initTimeoutMs);
      w.on('message', onMessage);
      // Every worker keeps an error listener; a crash also ends in 'exit'.
      w.on('error', () => undefined);
      w.once('exit', () => {
        if (live === w) live = undefined;
        done(false);
      });
    }).finally(() => {
      starting = undefined;
    });
    return starting;
  };

  const runNow = async (sql: string, checkOpts: GuardCheckOptions): Promise<GuardResult> => {
    if (closed) return refusal('unavailable', 'The SQL gate is closed.');
    const w = await start();
    if (w === undefined) {
      return refusal('unavailable', 'The SQL gate could not start, so nothing was run.');
    }
    const id = nextId++;
    return new Promise<GuardResult>((resolve) => {
      const finish = (result: GuardResult): void => {
        clearTimeout(timer);
        w.off('message', onMessage);
        w.off('exit', onExit);
        resolve(result);
      };
      const onMessage = (raw: unknown): void => {
        const reply = ReplySchema.safeParse(raw);
        if (!reply.success || !('id' in reply.data) || reply.data.id !== id) return;
        if ('result' in reply.data) finish(reply.data.result);
        else finish(refusal('unavailable', 'The SQL gate failed on this statement.'));
      };
      const onExit = (): void =>
        finish(refusal('unavailable', 'The SQL gate stopped while checking.'));
      const timer = setTimeout(() => {
        // A prepare can't be interrupted from outside: drop the worker, start fresh later.
        if (live === w) live = undefined;
        discard(w);
        finish(refusal('timeout', `The SQL gate took longer than ${checkTimeoutMs} ms.`));
      }, checkTimeoutMs);
      w.on('message', onMessage);
      w.on('exit', onExit);
      w.postMessage({ id, sql, opts: checkOpts });
    });
  };

  return {
    check(sql, checkOpts) {
      // Too long to judge: refuse here, without copying it to the worker.
      if (Buffer.byteLength(sql, 'utf8') > MAX_SQL_BYTES) {
        return Promise.resolve({
          ok: false,
          code: 'too-long',
          reason: `The statement is longer than ${MAX_SQL_BYTES / 1000} kB.`,
        });
      }
      const result = queue.then(() => runNow(sql, checkOpts));
      queue = result.catch(() => undefined);
      return result;
    },
    async close() {
      closed = true;
      const w = live ?? (await starting);
      live = undefined;
      if (w !== undefined) await w.terminate().catch(() => undefined);
    },
  };
}
