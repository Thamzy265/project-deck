/**
 * Runs `regex` log filters off the daemon's only thread, in core's budgeted worker. A
 * JavaScript regex can't be interrupted inside one match, and core's nested-quantifier
 * check misses shapes such as (a|a)*b. Plain `text` filtering stays on the main thread:
 * it can't backtrack.
 */
import type { Worker } from 'node:worker_threads';
import { BudgetedWorker } from '@project-deck/core/node';
import { z } from 'zod';

export const REGEX_TOO_SLOW = 'That regex took too long; use a simpler pattern or `text`';
export const REGEX_FAILED = "The regex couldn't be run; try again, or use `text`";
export const REGEX_BUDGET_MS = 200;

const HANDLER = `(p) => {
  const re = new RegExp(p.regex);
  return p.texts.map((t) => re.test(t));
}`;

export type RegexMatch =
  | { ok: true; matches: boolean[] }
  /** slow: over the budget. failed: no worker, or it died. */
  | { ok: false; reason: 'slow' | 'failed' };

export interface RegexFilterOptions {
  budgetMs?: number;
  /** Test seam: makes the worker. */
  createWorker?: (source: string) => Worker;
}

export class RegexFilter {
  private readonly worker: BudgetedWorker<{ regex: string; texts: string[] }, boolean[]>;

  constructor(opts: RegexFilterOptions = {}) {
    this.worker = new BudgetedWorker({
      handler: HANDLER,
      value: z.array(z.boolean()),
      budgetMs: opts.budgetMs ?? REGEX_BUDGET_MS,
      ...(opts.createWorker === undefined ? {} : { createWorker: opts.createWorker }),
    });
  }

  /** Whether each text matches `regex`. Calls run one after another, each with its budget. */
  async match(regex: string, texts: string[]): Promise<RegexMatch> {
    if (texts.length === 0) return { ok: true, matches: [] };
    const out = await this.worker.run({ regex, texts });
    if (out.state === 'done' && out.value.length === texts.length) {
      return { ok: true, matches: out.value };
    }
    return { ok: false, reason: out.state === 'timeout' ? 'slow' : 'failed' };
  }

  close(): Promise<void> {
    return this.worker.close();
  }
}
