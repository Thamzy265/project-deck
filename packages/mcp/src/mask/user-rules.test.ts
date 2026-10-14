import { afterEach, describe, expect, it } from 'vitest';
import { UserRuleRunner } from './user-rules.js';

const runners: UserRuleRunner[] = [];
function runner(rules: string[], budgetMs?: number): UserRuleRunner {
  const r = new UserRuleRunner(rules, budgetMs === undefined ? {} : { budgetMs });
  runners.push(r);
  return r;
}

afterEach(async () => {
  await Promise.all(runners.splice(0).map((r) => r.close()));
});

describe('user masking rules', () => {
  it('mask every match of every rule', async () => {
    const r = runner(['order-\\d+', 'Alice|Bob']);
    const result = await r.run(['order-42 for Alice', 'Bob paid order-7', 'nothing here']);
    expect(result).toEqual({
      texts: ['[masked] for [masked]', '[masked] paid [masked]', 'nothing here'],
      skipped: false,
    });
  });

  it('return the texts unchanged without rules, and start no worker', async () => {
    const r = runner([]);
    expect(await r.run(['a@b'])).toEqual({ texts: ['a@b'], skipped: false });
    expect(r.workerStarted).toBe(false);
  });

  it('stop a catastrophic rule within the budget and keep the rules before it', async () => {
    const r = runner(['secret', '(a|a)*b']);
    await r.ready();
    const line = `secret ${'a'.repeat(4089)}`;
    const start = performance.now();
    const result = await r.run([line]);
    const elapsed = performance.now() - start;
    expect(result.skipped).toBe(true);
    expect(result.texts).toEqual([`[masked] ${'a'.repeat(4089)}`]);
    // 200 ms budget plus a margin for a slow CI machine.
    expect(elapsed).toBeLessThan(450);
  });

  it('work again after a timeout, with a fresh worker', async () => {
    const r = runner(['(a|a)*b', 'x'], 100);
    expect((await r.run(['a'.repeat(4096)])).skipped).toBe(true);
    expect(await r.run(['short x'])).toEqual({ texts: ['short [masked]'], skipped: false });
  });

  it('run overlapping calls one after another', async () => {
    const r = runner(['n\\d']);
    const results = await Promise.all([r.run(['n1']), r.run(['n2']), r.run(['n3'])]);
    expect(results.map((x) => x.texts[0])).toEqual(['[masked]', '[masked]', '[masked]']);
  });

  it('skip the rules when one fails inside the worker', async () => {
    // Config validation refuses invalid rules; this guards against one getting through.
    const r = runner(['ok', '(']);
    const result = await r.run(['ok then']);
    expect(result).toEqual({ texts: ['[masked] then'], skipped: true });
    expect(await r.run(['fine'])).toEqual({ texts: ['fine'], skipped: true });
  });
});
