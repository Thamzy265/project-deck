/**
 * Runs code that may never finish, such as a user's regular expression, in a worker
 * thread with a time budget. A JavaScript regex can't be interrupted inside one match,
 * so the worker is terminated when the budget runs out and a fresh one starts on the
 * next call. Used by the daemon's regex log filter and the MCP server's masking rules.
 */
import { Worker } from 'node:worker_threads';
import type { z } from 'zod';

export type BudgetedOutcome<V> =
  | { state: 'done'; value: V }
  /**
   * `last` is the newest progress value the handler reported, if any.
   * timeout: over budget. failed: the handler threw or the worker died.
   * unavailable: no worker could be started. closed: called after close().
   */
  | { state: 'timeout' | 'failed' | 'unavailable' | 'closed'; last: V | undefined };

export interface BudgetedWorkerOptions<V> {
  /**
   * Source of a plain JavaScript function `(payload, progress) => value`. It runs in
   * the worker, so it can't close over anything; `progress(value)` reports partial work.
   */
  handler: string;
  /** Validates every value the worker sends back. */
  value: z.ZodType<V>;
  budgetMs: number;
  /** How long a new worker may take to say it is ready. Starting takes ~15 ms. */
  startupMs?: number;
  /** Test seam: makes the worker. */
  createWorker?: (source: string) => Worker;
}

const wrap = (handler: string) => `
const { parentPort } = require('node:worker_threads');
const handle = (${handler});
parentPort.on('message', ({ id, payload }) => {
  let reply;
  try {
    const progress = (value) => parentPort.postMessage({ id, state: 'progress', value });
    reply = { id, state: 'done', value: handle(payload, progress) };
  } catch {
    reply = { id, state: 'failed' };
  }
  parentPort.postMessage(reply);
});
parentPort.postMessage({ ready: true });
`;

interface Reply {
  id?: unknown;
  state?: unknown;
  value?: unknown;
  ready?: unknown;
}

export class BudgetedWorker<P, V> {
  private worker: Worker | undefined;
  private starting: Promise<Worker | undefined> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 0;
  private isClosed = false;
  private readonly source: string;
  private readonly startupMs: number;
  private readonly createWorker: (source: string) => Worker;

  constructor(private readonly opts: BudgetedWorkerOptions<V>) {
    this.source = wrap(opts.handler);
    this.startupMs = opts.startupMs ?? 5000;
    this.createWorker = opts.createWorker ?? ((source) => new Worker(source, { eval: true }));
  }

  get closed(): boolean {
    return this.isClosed;
  }

  get started(): boolean {
    return this.worker !== undefined || this.starting !== undefined;
  }

  /** Starts the worker ahead of the first call, so that call has its whole budget. */
  async ready(): Promise<boolean> {
    if (this.isClosed) return false;
    return (await this.start()) !== undefined;
  }

  /** Runs `payload` through the handler. Calls run one after another, each with its budget. */
  run(payload: P): Promise<BudgetedOutcome<V>> {
    const result = this.queue.then(() => this.runNow(payload));
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Stops the worker. Never rejects; later calls answer `closed` without a worker. */
  async close(): Promise<void> {
    this.isClosed = true;
    const worker = this.worker ?? (await this.starting);
    this.worker = undefined;
    this.starting = undefined;
    await worker?.terminate().catch(() => undefined);
  }

  private async runNow(payload: P): Promise<BudgetedOutcome<V>> {
    if (this.isClosed) return { state: 'closed', last: undefined };
    const worker = await this.start();
    if (worker === undefined) return { state: 'unavailable', last: undefined };
    const id = this.nextId++;
    return new Promise((resolve) => {
      let last: V | undefined;
      const finish = (outcome: BudgetedOutcome<V>) => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('exit', onExit);
        resolve(outcome);
      };
      const onMessage = (raw: unknown) => {
        const reply = (typeof raw === 'object' && raw !== null ? raw : {}) as Reply;
        if (reply.id !== id) return;
        if (reply.state === 'failed') return finish({ state: 'failed', last });
        const value = this.opts.value.safeParse(reply.value);
        if (!value.success) {
          this.discard(worker);
          return finish({ state: 'failed', last });
        }
        if (reply.state === 'done') return finish({ state: 'done', value: value.data });
        last = value.data;
      };
      const onExit = () => finish({ state: 'failed', last });
      const timer = setTimeout(() => {
        this.discard(worker);
        finish({ state: 'timeout', last });
      }, this.opts.budgetMs);
      worker.on('message', onMessage);
      worker.on('exit', onExit);
      worker.postMessage({ id, payload });
    });
  }

  /** The running worker, or a new one once it has said it is ready; undefined if none starts. */
  private start(): Promise<Worker | undefined> {
    if (this.worker !== undefined) return Promise.resolve(this.worker);
    if (this.starting !== undefined) return this.starting;
    let worker: Worker;
    try {
      worker = this.createWorker(this.source);
    } catch {
      // Not cached: the next call tries again.
      return Promise.resolve(undefined);
    }
    this.starting = new Promise<Worker | undefined>((resolve) => {
      // Never keeps the process alive; its server does that.
      worker.unref();
      let settled = false;
      const settle = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.starting = undefined;
        if (ok && !this.isClosed) {
          this.worker = worker;
          resolve(worker);
        } else {
          void worker.terminate().catch(() => undefined);
          resolve(undefined);
        }
      };
      const timer = setTimeout(() => settle(false), this.startupMs);
      // A crash also ends in 'exit', which a waiting call handles.
      worker.on('error', () => undefined);
      worker.once('exit', () => {
        if (this.worker === worker) this.worker = undefined;
        settle(false);
      });
      worker.once('message', (raw: unknown) => {
        settle(typeof raw === 'object' && raw !== null && (raw as Reply).ready === true);
      });
    });
    return this.starting;
  }

  /** Stops a worker stuck in a call (or misbehaving); the next call starts a fresh one. */
  private discard(worker: Worker): void {
    if (this.worker === worker) this.worker = undefined;
    void worker.terminate().catch(() => undefined);
  }
}
