/**
 * Tester probes of the user-rule worker (design D4): many slow rules, rules that match
 * everything or nothing, capture groups and backreferences, an invalid rule, and a
 * runner closed while a call waits.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Masker } from './masker.js';
import { USER_RULE_MARKER, UserRuleRunner } from './user-rules.js';

const runners: { close(): Promise<void> }[] = [];
function runner(rules: string[], budgetMs?: number): UserRuleRunner {
  const r = new UserRuleRunner(rules, budgetMs === undefined ? {} : { budgetMs });
  runners.push(r);
  return r;
}

afterEach(async () => {
  await Promise.all(runners.splice(0).map((r) => r.close()));
});

/** Slow on a long run of 'a' without a 'b', and not a nested quantifier the config refuses. */
const SLOW = '(a|a)*b';
const LONG = 'a'.repeat(4000);

describe('user rules under load', () => {
  it('keeps the 200 ms budget for one call with 20 slow rules', async () => {
    const r = runner(Array.from({ length: 20 }, () => SLOW));
    await r.ready();
    const start = performance.now();
    const result = await r.run([LONG, 'jane']);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(result).toEqual({ texts: [LONG, 'jane'], skipped: true });
  });

  it('keeps the budget per call, call after call, with a fresh worker each time', async () => {
    const r = runner(['secret', SLOW]);
    await r.ready();
    const start = performance.now();
    const results = await Promise.all([r.run([LONG + ' secret']), r.run(['secret ' + LONG])]);
    // Two queued calls, each stopped at its own budget.
    expect(performance.now() - start).toBeLessThan(2000);
    expect(results.map((x) => x.skipped)).toEqual([true, true]);
    expect(results[0].texts[0]?.endsWith(` ${USER_RULE_MARKER}`)).toBe(true);
    expect(results[1].texts[0]?.startsWith(`${USER_RULE_MARKER} `)).toBe(true);
  });

  it('masks a whole text with a rule that matches everything', async () => {
    const result = await runner(['[\\s\\S]+']).run(['jane doe', '']);
    expect(result).toEqual({ texts: [USER_RULE_MARKER, ''], skipped: false });
  });

  it('only grows the text with a rule that matches the empty string, never hangs', async () => {
    const result = await runner(['x?']).run(['ab']);
    expect(result.skipped).toBe(false);
    expect(result.texts).toEqual([`${USER_RULE_MARKER}a${USER_RULE_MARKER}b${USER_RULE_MARKER}`]);
  });

  it('replaces the whole match, never a $1 or $& taken from the rule', async () => {
    const result = await runner(['(order)-(\\d+)', '(\\w)\\1{2}']).run(['order-42 zzz']);
    expect(result.texts).toEqual([`${USER_RULE_MARKER} ${USER_RULE_MARKER}`]);
  });

  it('skips the rest after an invalid rule and keeps the rules before it', async () => {
    // The config refuses invalid rules; this guards a Masker built some other way.
    const result = await runner(['jane', '(unclosed', 'doe']).run(['jane doe']);
    expect(result).toEqual({ texts: [`${USER_RULE_MARKER} doe`], skipped: true });
  });

  it('answers a call queued behind close() as skipped, never hangs', async () => {
    const r = runner(['jane']);
    await r.ready();
    const closing = r.close();
    const result = await r.run(['jane']);
    await closing;
    // Either it ran on a fresh worker or it was skipped; it must answer.
    expect([USER_RULE_MARKER, 'jane']).toContain(result.texts[0]);
  });

  it('BUG-MCP-T9: starts no new worker for a call made after close()', async () => {
    // The server closes the old Masker when the config changes; a call still using it
    // must not leave a worker behind that nothing terminates.
    const r = runner(['jane']);
    await r.ready();
    await r.close();
    await r.run(['jane']);
    expect(r.workerStarted).toBe(false);
  });
});

describe('Masker with user rules', () => {
  it('runs user rules after the built-ins, so a rule cannot reveal a masked value', async () => {
    const m = new Masker({ redact: true, rules: ['masked', 'email'] });
    runners.push(m);
    const out = await m.mask('jane@example.com');
    expect(out.value).not.toContain('jane');
    expect(out.notes).toEqual([]);
  });

  it('keeps the built-ins when every user rule is slow', async () => {
    const m = new Masker({ redact: true, rules: Array.from({ length: 20 }, () => SLOW) });
    runners.push(m);
    await m.ready();
    const out = await m.mask({ message: `jane@example.com ${LONG}` });
    expect(out.value.message.startsWith('[email masked] aaa')).toBe(true);
    expect(out.notes).toEqual(['Some masking rules were skipped (too slow)']);
  });
});
