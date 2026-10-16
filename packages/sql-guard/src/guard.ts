import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import type { GuardCheckOptions, GuardResult } from './types.js';
import { schemaKey } from './schema-key.js';
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
  /** Loading a new schema into the scratch database (lead decision 16 Oct 2026: 5 s). */
  schemaTimeoutMs?: number;
  /** One check, once its schema is loaded (ADR 0005 amended: 1 s). */
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
  z.object({ id: z.number(), schema: z.literal(true) }),
  z.object({ id: z.number(), missing: z.literal(true) }),
]);

/** What the worker said to a request: a verdict, or that a schema loaded or is gone. */
type Answer = GuardResult | 'loaded' | 'missing';

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
  const schemaTimeoutMs = opts.schemaTimeoutMs ?? 5000;
  const workerUrl = opts.workerUrl ?? new URL('./worker.js', import.meta.url);
  let live: Worker | undefined;
  let starting: Promise<Worker | undefined> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let nextId = 0;
  let closed = false;
  // Hashing a large schema costs time: once per schema array, never inside a budget.
  // Each entry keeps a frozen copy, so an array changed in place is noticed (S8).
  const keys = new WeakMap<readonly string[], { key: string; copy: readonly string[] }>();
  const keyOf = (schemaSql: readonly string[]): { key: string; copy: readonly string[] } => {
    const cached = keys.get(schemaSql);
    // Comparing the strings by identity is far cheaper than hashing them again.
    if (
      cached !== undefined &&
      cached.copy.length === schemaSql.length &&
      cached.copy.every((s, i) => s === schemaSql[i])
    ) {
      return cached;
    }
    const copy = Object.freeze([...schemaSql]);
    const entry = { key: schemaKey(copy), copy };
    keys.set(schemaSql, entry);
    return entry;
  };
  // Schemas the live worker holds; a fresh worker starts with none.
  let loadedBy: Worker | undefined;
  const loaded = new Set<string>();

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

  /**
   * Sends one request and waits for its answer within `budgetMs`. Resolves to the
   * worker's answer, or a refusal when anything goes wrong.
   */
  const ask = (
    w: Worker,
    message: Record<string, unknown>,
    budgetMs: number,
    overBudget: string,
  ): Promise<Answer> => {
    const id = nextId++;
    return new Promise<Answer>((resolve) => {
      const finish = (result: Answer): void => {
        clearTimeout(timer);
        w.off('message', onMessage);
        w.off('exit', onExit);
        resolve(result);
      };
      const onMessage = (raw: unknown): void => {
        const reply = ReplySchema.safeParse(raw);
        if (!reply.success || !('id' in reply.data) || reply.data.id !== id) return;
        if ('result' in reply.data) finish(reply.data.result);
        else if ('schema' in reply.data) finish('loaded');
        else if ('missing' in reply.data) finish('missing');
        else finish(refusal('unavailable', 'The SQL gate failed on this statement.'));
      };
      const onExit = (): void =>
        finish(refusal('unavailable', 'The SQL gate stopped while checking.'));
      const timer = setTimeout(() => {
        // A prepare can't be interrupted from outside: drop the worker, start fresh later.
        if (live === w) live = undefined;
        discard(w);
        finish(refusal('timeout', overBudget));
      }, budgetMs);
      w.on('message', onMessage);
      w.on('exit', onExit);
      try {
        w.postMessage({ ...message, id });
      } catch {
        // Uncloneable input (DataCloneError) or a closing port: refuse, never reject.
        finish(refusal('unavailable', 'The SQL gate could not receive this request.'));
      }
    });
  };

  const runNow = async (sql: string, checkOpts: GuardCheckOptions): Promise<GuardResult> => {
    if (closed) return refusal('unavailable', 'The SQL gate is closed.');
    const w = await start();
    if (w === undefined) {
      return refusal('unavailable', 'The SQL gate could not start, so nothing was run.');
    }
    if (loadedBy !== w) {
      loadedBy = w;
      loaded.clear();
    }
    const { schemaSql: given, ...rest } = checkOpts;
    const { key, copy: schemaSql } = keyOf(given);
    // The worker may have dropped the schema from its cache: load it again, once.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!loaded.has(key)) {
        // A new schema can take a while to load; that gets its own, larger budget.
        const answer = await ask(
          w,
          { kind: 'schema', key, schemaSql },
          schemaTimeoutMs,
          `Loading the database schema into the SQL gate took longer than ${schemaTimeoutMs} ms.`,
        );
        if (answer !== 'loaded') return answer === 'missing' ? outOfTurn() : answer;
        loaded.add(key);
      }
      const verdict = await ask(
        w,
        { kind: 'check', key, sql, opts: rest },
        checkTimeoutMs,
        `The SQL gate took longer than ${checkTimeoutMs} ms.`,
      );
      if (verdict !== 'missing') return verdict === 'loaded' ? outOfTurn() : verdict;
      loaded.delete(key);
    }
    return refusal('unavailable', 'The SQL gate kept losing the database schema.');
  };

  const outOfTurn = (): GuardResult => refusal('unavailable', 'The SQL gate answered out of turn.');

  return {
    check(sql, checkOpts) {
      if (typeof sql !== 'string') {
        return Promise.resolve(refusal('unavailable', 'The SQL gate was given no SQL text.'));
      }
      // Too long to judge: refuse here, without copying it to the worker.
      if (Buffer.byteLength(sql, 'utf8') > MAX_SQL_BYTES) {
        return Promise.resolve({
          ok: false,
          code: 'too-long',
          reason: `The statement is longer than ${MAX_SQL_BYTES / 1000} kB.`,
        });
      }
      // check() never rejects: any unexpected failure refuses instead.
      const result = queue
        .then(() => runNow(sql, checkOpts))
        .catch(() => refusal('unavailable', 'The SQL gate failed unexpectedly.'));
      queue = result;
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
