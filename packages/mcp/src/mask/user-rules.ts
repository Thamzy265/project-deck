/**
 * Runs the user's masking rules from `logs.rules` (design D4). A JavaScript regex can't
 * be interrupted inside one match, so the rules run in a worker thread that is
 * terminated when the per-call budget runs out; the rules it finished still count.
 */
import { Worker } from 'node:worker_threads';
import { z } from 'zod';

export const USER_RULE_MARKER = '[masked]';
export const DEFAULT_BUDGET_MS = 200;
/** Starting a worker takes ~15 ms; this only guards against a machine under heavy load. */
const DEFAULT_STARTUP_MS = 5000;

/**
 * Plain JavaScript, run with `eval` so it needs no separate file next to the built
 * output or the TypeScript sources. It posts the texts after every rule, so a
 * timeout keeps the rules that finished.
 */
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', ({ id, rules, texts, marker }) => {
  let out = texts;
  for (let i = 0; i < rules.length; i++) {
    try {
      const re = new RegExp(rules[i], 'g');
      out = out.map((t) => t.replace(re, marker));
    } catch {
      parentPort.postMessage({ id, texts: out, state: 'failed' });
      return;
    }
    parentPort.postMessage({ id, texts: out, state: i === rules.length - 1 ? 'done' : 'progress' });
  }
});
parentPort.postMessage({ ready: true });
`;

const WorkerMessage = z.union([
  z.object({ ready: z.literal(true) }),
  z.object({
    id: z.number(),
    texts: z.array(z.string()),
    state: z.enum(['progress', 'done', 'failed']),
  }),
]);

export interface UserRuleResult {
  texts: string[];
  /** True when some rules didn't run: too slow, or the worker failed. */
  skipped: boolean;
}

export interface UserRuleOptions {
  budgetMs?: number;
  startupMs?: number;
}

export class UserRuleRunner {
  private worker: Worker | undefined;
  private starting: Promise<Worker | undefined> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 0;
  private isClosed = false;
  private readonly budgetMs: number;
  private readonly startupMs: number;

  constructor(
    private readonly rules: readonly string[],
    opts: UserRuleOptions = {},
  ) {
    this.budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
    this.startupMs = opts.startupMs ?? DEFAULT_STARTUP_MS;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  get workerStarted(): boolean {
    return this.worker !== undefined || this.starting !== undefined;
  }

  /** Starts the worker ahead of the first call, so that call has its whole budget. */
  async ready(): Promise<void> {
    if (this.rules.length > 0 && !this.isClosed) await this.start();
  }

  /** Masks every text with every rule, in order. Calls run one after another. */
  run(texts: string[]): Promise<UserRuleResult> {
    if (this.rules.length === 0 || texts.length === 0) {
      return Promise.resolve({ texts, skipped: false });
    }
    const result = this.queue.then(() => this.runNow(texts));
    this.queue = result.catch(() => undefined);
    return result;
  }

  async close(): Promise<void> {
    this.isClosed = true;
    const worker = this.worker ?? (await this.starting);
    this.worker = undefined;
    this.starting = undefined;
    await worker?.terminate();
  }

  private async runNow(texts: string[]): Promise<UserRuleResult> {
    // After close nothing would terminate a new worker, so the rules don't run.
    if (this.isClosed) return { texts, skipped: true };
    const worker = await this.start();
    if (worker === undefined) return { texts, skipped: true };
    const id = this.nextId++;
    return new Promise<UserRuleResult>((resolve) => {
      let latest = texts;
      const finish = (skipped: boolean) => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('exit', onExit);
        resolve({ texts: latest, skipped });
      };
      const onMessage = (raw: unknown) => {
        const msg = WorkerMessage.safeParse(raw);
        if (!msg.success || !('id' in msg.data) || msg.data.id !== id) return;
        latest = msg.data.texts;
        if (msg.data.state === 'done') finish(false);
        else if (msg.data.state === 'failed') finish(true);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => {
        this.discard(worker);
        finish(true);
      }, this.budgetMs);
      worker.on('message', onMessage);
      worker.on('exit', onExit);
      worker.postMessage({ id, rules: this.rules, texts, marker: USER_RULE_MARKER });
    });
  }

  /** The running worker, or a new one once it has said it is ready; undefined if it can't start. */
  private start(): Promise<Worker | undefined> {
    if (this.worker !== undefined) return Promise.resolve(this.worker);
    this.starting ??= new Promise<Worker | undefined>((resolve) => {
      const worker = new Worker(WORKER_SOURCE, { eval: true });
      // Never keeps the process alive; stdio does that for the server.
      worker.unref();
      let settled = false;
      const settle = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.starting = undefined;
        if (ok) {
          this.worker = worker;
          resolve(worker);
        } else {
          this.discard(worker);
          resolve(undefined);
        }
      };
      const timer = setTimeout(() => settle(false), this.startupMs);
      // A crash also ends in 'exit', which the waiting call handles.
      worker.on('error', () => undefined);
      worker.once('exit', () => {
        if (this.worker === worker) this.worker = undefined;
        settle(false);
      });
      worker.once('message', (raw: unknown) => {
        const msg = WorkerMessage.safeParse(raw);
        settle(msg.success && 'ready' in msg.data);
      });
    });
    return this.starting;
  }

  /** Stops a worker that is stuck in a match; the next call starts a fresh one. */
  private discard(worker: Worker): void {
    if (this.worker === worker) this.worker = undefined;
    void worker.terminate().catch(() => undefined);
  }
}
