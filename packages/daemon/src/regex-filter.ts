/**
 * Runs `regex` log filters off the daemon's only thread. A JavaScript regex can't be
 * interrupted inside one match, and core's nested-quantifier check misses shapes such as
 * (a|a)*b, so the match runs in a worker that is terminated when the budget runs out.
 * Plain `text` filtering stays on the main thread: it can't backtrack.
 */
import { Worker } from 'node:worker_threads';
import { z } from 'zod';

export const REGEX_TOO_SLOW = 'That regex took too long; use a simpler pattern or `text`';
export const REGEX_BUDGET_MS = 200;
/** Starting a worker takes ~15 ms; this only guards against a machine under heavy load. */
const STARTUP_MS = 5000;

/** Plain JavaScript, run with `eval` so it needs no file next to the build or the sources. */
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', ({ id, regex, texts }) => {
  try {
    const re = new RegExp(regex);
    parentPort.postMessage({ id, matches: texts.map((t) => re.test(t)) });
  } catch {
    parentPort.postMessage({ id, matches: null });
  }
});
parentPort.postMessage({ ready: true });
`;

const WorkerMessage = z.union([
  z.object({ ready: z.literal(true) }),
  z.object({ id: z.number(), matches: z.array(z.boolean()).nullable() }),
]);

export class RegexFilter {
  private worker: Promise<Worker | undefined> | undefined;
  /** The started worker, once it has said it is ready. */
  private current: Worker | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 0;
  private closed = false;

  constructor(private readonly budgetMs: number = REGEX_BUDGET_MS) {}

  /**
   * Whether each text matches `regex`, or undefined when it took longer than the budget
   * (or couldn't run). Calls run one after another, each with its own budget.
   */
  match(regex: string, texts: string[]): Promise<boolean[] | undefined> {
    if (texts.length === 0) return Promise.resolve([]);
    const result = this.queue.then(() => this.matchNow(regex, texts));
    this.queue = result.catch(() => undefined);
    return result;
  }

  async close(): Promise<void> {
    this.closed = true;
    const worker = await this.worker;
    this.worker = undefined;
    await worker?.terminate();
  }

  private async matchNow(regex: string, texts: string[]): Promise<boolean[] | undefined> {
    if (this.closed) return undefined;
    const worker = await this.start();
    if (worker === undefined) return undefined;
    const id = this.nextId++;
    return new Promise((resolve) => {
      const finish = (matches: boolean[] | undefined) => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('exit', onExit);
        resolve(matches);
      };
      const onMessage = (raw: unknown) => {
        const msg = WorkerMessage.safeParse(raw);
        if (!msg.success || !('id' in msg.data) || msg.data.id !== id) return;
        const { matches } = msg.data;
        finish(matches?.length === texts.length ? matches : undefined);
      };
      const onExit = () => finish(undefined);
      const timer = setTimeout(() => {
        this.discard(worker);
        finish(undefined);
      }, this.budgetMs);
      worker.on('message', onMessage);
      worker.on('exit', onExit);
      worker.postMessage({ id, regex, texts });
    });
  }

  private start(): Promise<Worker | undefined> {
    this.worker ??= new Promise<Worker | undefined>((resolve) => {
      const worker = new Worker(WORKER_SOURCE, { eval: true });
      // Never keeps the daemon alive; its server does that.
      worker.unref();
      let settled = false;
      const settle = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ok) {
          this.current = worker;
          return resolve(worker);
        }
        this.worker = undefined;
        void worker.terminate().catch(() => undefined);
        resolve(undefined);
      };
      const timer = setTimeout(() => settle(false), STARTUP_MS);
      // A crash also ends in 'exit', which a waiting match handles.
      worker.on('error', () => undefined);
      worker.once('exit', () => {
        settle(false);
        if (this.current === worker) this.discard(worker);
      });
      worker.once('message', (raw: unknown) => {
        const msg = WorkerMessage.safeParse(raw);
        settle(msg.success && 'ready' in msg.data);
      });
    });
    return this.worker;
  }

  /** Drops a worker stuck in a match (or gone); the next match starts a fresh one. */
  private discard(worker: Worker): void {
    if (this.current === worker) {
      this.current = undefined;
      this.worker = undefined;
    }
    void worker.terminate().catch(() => undefined);
  }
}
