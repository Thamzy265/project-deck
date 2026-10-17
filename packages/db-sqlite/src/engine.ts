import { Worker } from 'node:worker_threads';
import type { KeyedRows, QueryResult, RowHashes, RowKey, TableInfo } from '@project-deck/core';
import {
  DbError,
  DbErrorCodeSchema,
  KeyedRowsSchema,
  QueryResultSchema,
  RowHashesSchema,
  TableInfoSchema,
} from '@project-deck/core';
import { z } from 'zod';

export interface SnapshotEngineOptions {
  /** One call, once the copy is open (design: the same 5 s limit as the app). */
  budgetMs?: number;
  /** Starting the worker and opening a copy (up to 50 MB). */
  openMs?: number;
  /** Test seam: the worker script. Defaults to the built worker next to this file. */
  workerUrl?: URL;
}

const Reply = z.union([
  z.object({ ready: z.literal(true) }),
  z.object({ id: z.number(), ok: z.literal(true), value: z.unknown() }),
  z.object({ id: z.number(), ok: z.literal(false), code: DbErrorCodeSchema, message: z.string() }),
]);
const SchemaValue = z.object({ tables: z.array(TableInfoSchema), sqlSchema: z.array(z.string()) });

const TOO_LONG = 'That query took too long and was stopped.';

/**
 * Reads one snapshot copy in a worker thread with a time budget per call. When a call
 * passes its budget the worker is terminated (a wasm step can't be interrupted from
 * outside) and the next call starts a fresh worker and opens the same copy again.
 * The copy lives in memory only and is dropped by close() (design note, Privacy).
 */
export class SnapshotEngine {
  private readonly budgetMs: number;
  private readonly openMs: number;
  private readonly workerUrl: URL;
  private bytes: Uint8Array | undefined;
  private worker: Worker | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 0;
  private closed = false;

  constructor(opts: SnapshotEngineOptions = {}) {
    this.budgetMs = opts.budgetMs ?? 5000;
    this.openMs = opts.openMs ?? 10_000;
    this.workerUrl = opts.workerUrl ?? new URL('./worker.js', import.meta.url);
  }

  /** Replaces the copy this engine reads. */
  load(bytes: Uint8Array): void {
    this.bytes = bytes;
    this.drop();
  }

  async schema(): Promise<{ tables: TableInfo[]; sqlSchema: string[] }> {
    return SchemaValue.parse(await this.call({ op: 'schema' }));
  }

  async query(sql: string, params: unknown[], limit: number): Promise<QueryResult> {
    return QueryResultSchema.parse(await this.call({ op: 'query', sql, params, limit }));
  }

  async hashes(): Promise<RowHashes> {
    return RowHashesSchema.parse(await this.call({ op: 'hashes' }));
  }

  async rowsByKey(table: string, keys: RowKey[]): Promise<KeyedRows> {
    return KeyedRowsSchema.parse(await this.call({ op: 'rows', table, keys }));
  }

  /** Stops the worker and forgets the copy. Later calls refuse. */
  close(): Promise<void> {
    this.closed = true;
    this.bytes = undefined;
    this.drop();
    return Promise.resolve();
  }

  private drop(): void {
    const w = this.worker;
    this.worker = undefined;
    if (w !== undefined) void w.terminate().catch(() => undefined);
  }

  /** Calls run one at a time, so a timeout always belongs to the call that caused it. */
  private call(message: Record<string, unknown>): Promise<unknown> {
    const run = this.queue.then(() => this.callNow(message));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async callNow(message: Record<string, unknown>): Promise<unknown> {
    if (this.closed || this.bytes === undefined) {
      throw new DbError('internal', 'No snapshot copy is open; take a snapshot first.');
    }
    const w = await this.ready(this.bytes);
    return this.ask(w, message, this.budgetMs, TOO_LONG);
  }

  /** The live worker with the copy open, starting one if needed. */
  private async ready(bytes: Uint8Array): Promise<Worker> {
    if (this.worker !== undefined) return this.worker;
    const w = new Worker(this.workerUrl, { execArgv: [] });
    w.unref();
    // Every worker keeps an error listener; a crash also ends in 'exit'.
    w.on('error', () => undefined);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        void w.terminate().catch(() => undefined);
        reject(new DbError('timeout', 'The snapshot engine took too long to start.'));
      }, this.openMs);
      const onMessage = (raw: unknown): void => {
        if (Reply.safeParse(raw).data && 'ready' in (raw as object)) {
          clearTimeout(timer);
          w.off('message', onMessage);
          resolve();
        }
      };
      w.on('message', onMessage);
      w.once('exit', () => {
        clearTimeout(timer);
        reject(new DbError('internal', 'The snapshot engine stopped.'));
      });
    });
    await this.ask(w, { op: 'open', bytes }, this.openMs, 'Opening the snapshot took too long.');
    this.worker = w;
    return w;
  }

  private ask(
    w: Worker,
    message: Record<string, unknown>,
    budgetMs: number,
    overBudget: string,
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const finish = (fn: () => void): void => {
        clearTimeout(timer);
        w.off('message', onMessage);
        w.off('exit', onExit);
        fn();
      };
      const onMessage = (raw: unknown): void => {
        const reply = Reply.safeParse(raw);
        if (!reply.success || !('id' in reply.data) || reply.data.id !== id) return;
        const data = reply.data;
        if (data.ok) finish(() => resolve(data.value));
        else finish(() => reject(new DbError(data.code, data.message)));
      };
      const onExit = (): void => {
        if (this.worker === w) this.worker = undefined;
        finish(() => reject(new DbError('internal', 'The snapshot engine stopped.')));
      };
      const timer = setTimeout(() => {
        if (this.worker === w) this.worker = undefined;
        void w.terminate().catch(() => undefined);
        finish(() => reject(new DbError('timeout', overBudget)));
      }, budgetMs);
      w.on('message', onMessage);
      w.on('exit', onExit);
      w.postMessage({ ...message, id });
    });
  }
}
