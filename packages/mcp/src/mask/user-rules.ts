/**
 * Runs the user's masking rules from `logs.rules` (design D4) in core's budgeted
 * worker: it is terminated when the per-call budget runs out, and the rules it
 * finished still count.
 */
import { BudgetedWorker } from '@project-deck/core/node';
import { z } from 'zod';

export const USER_RULE_MARKER = '[masked]';
export const DEFAULT_BUDGET_MS = 200;

/** Reports the texts after every rule, so a timeout keeps the rules that finished. */
const HANDLER = `(p, progress) => {
  let out = p.texts;
  for (let i = 0; i < p.rules.length; i++) {
    const re = new RegExp(p.rules[i], 'g');
    out = out.map((t) => t.replace(re, p.marker));
    if (i < p.rules.length - 1) progress(out);
  }
  return out;
}`;

interface Payload {
  rules: readonly string[];
  texts: string[];
  marker: string;
}

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
  private readonly worker: BudgetedWorker<Payload, string[]>;

  constructor(
    private readonly rules: readonly string[],
    opts: UserRuleOptions = {},
  ) {
    this.worker = new BudgetedWorker({
      handler: HANDLER,
      value: z.array(z.string()),
      budgetMs: opts.budgetMs ?? DEFAULT_BUDGET_MS,
      ...(opts.startupMs === undefined ? {} : { startupMs: opts.startupMs }),
    });
  }

  get closed(): boolean {
    return this.worker.closed;
  }

  get workerStarted(): boolean {
    return this.worker.started;
  }

  /** Starts the worker ahead of the first call, so that call has its whole budget. */
  async ready(): Promise<void> {
    if (this.rules.length > 0) await this.worker.ready();
  }

  /** Masks every text with every rule, in order. Calls run one after another. */
  async run(texts: string[]): Promise<UserRuleResult> {
    if (this.rules.length === 0 || texts.length === 0) return { texts, skipped: false };
    const out = await this.worker.run({ rules: this.rules, texts, marker: USER_RULE_MARKER });
    if (out.state === 'done' && out.value.length === texts.length) {
      return { texts: out.value, skipped: false };
    }
    const last = out.state === 'done' ? undefined : out.last;
    return { texts: last?.length === texts.length ? last : texts, skipped: true };
  }

  close(): Promise<void> {
    return this.worker.close();
  }
}
