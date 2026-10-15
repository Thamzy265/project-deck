import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BudgetedWorker } from './budgeted-worker.js';

/** Applies each regex in turn, reporting progress after each one. */
const HANDLER = `(p, progress) => {
  let out = p.text;
  for (const source of p.rules) {
    out = out.replace(new RegExp(source, 'g'), '#');
    progress(out);
  }
  return out;
}`;

type Payload = { rules: string[]; text: string };
const workers: BudgetedWorker<Payload, string>[] = [];

function worker(
  opts: Partial<ConstructorParameters<typeof BudgetedWorker<Payload, string>>[0]> = {},
) {
  const w = new BudgetedWorker<Payload, string>({
    handler: HANDLER,
    value: z.string(),
    budgetMs: 200,
    ...opts,
  });
  workers.push(w);
  return w;
}

afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.close()));
});

describe('BudgetedWorker', () => {
  it('returns the handler value', async () => {
    expect(await worker().run({ rules: ['a', 'b'], text: 'abc' })).toEqual({
      state: 'done',
      value: '##c',
    });
  });

  it('stops a catastrophic call within the budget and keeps the last progress', async () => {
    const w = worker();
    await w.ready();
    const start = performance.now();
    const out = await w.run({ rules: ['x', '(a|a)*b'], text: `x${'a'.repeat(4000)}` });
    expect(performance.now() - start).toBeLessThan(450);
    expect(out).toEqual({ state: 'timeout', last: `#${'a'.repeat(4000)}` });
    // A fresh worker answers the next call.
    expect(await w.run({ rules: ['c'], text: 'abc' })).toEqual({ state: 'done', value: 'ab#' });
  });

  it('reports a handler that throws as failed, with its progress', async () => {
    const out = await worker().run({ rules: ['a', '('], text: 'abc' });
    expect(out).toEqual({ state: 'failed', last: '#bc' });
  });

  it('refuses a value of the wrong shape', async () => {
    const w = worker({ handler: '() => 42' });
    expect(await w.run({ rules: [], text: '' })).toEqual({ state: 'failed', last: undefined });
  });

  it("answers unavailable when the worker can't be made, and tries again next time", async () => {
    let attempts = 0;
    const w = worker({
      createWorker: () => {
        attempts++;
        throw new Error('ERR_WORKER_INIT_FAILED');
      },
    });
    expect(await w.run({ rules: [], text: '' })).toEqual({ state: 'unavailable', last: undefined });
    expect(await w.ready()).toBe(false);
    expect(attempts).toBe(2);
  });

  it('runs overlapping calls one after another', async () => {
    const w = worker();
    const outs = await Promise.all(['a', 'b', 'c'].map((r) => w.run({ rules: [r], text: 'abc' })));
    expect(outs.map((o) => (o.state === 'done' ? o.value : o.state))).toEqual([
      '#bc',
      'a#c',
      'ab#',
    ]);
  });

  it('starts no worker after close, and close never rejects', async () => {
    const w = worker();
    await w.ready();
    await w.close();
    await expect(w.close()).resolves.toBeUndefined();
    expect(await w.run({ rules: ['a'], text: 'a' })).toEqual({ state: 'closed', last: undefined });
    expect(await w.ready()).toBe(false);
    expect(w.started).toBe(false);
  });
});
