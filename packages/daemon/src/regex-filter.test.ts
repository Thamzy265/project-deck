import { afterEach, describe, expect, it } from 'vitest';
import { RegexFilter } from './regex-filter.js';

const filters: RegexFilter[] = [];
function filter(opts: ConstructorParameters<typeof RegexFilter>[0] = {}): RegexFilter {
  const f = new RegexFilter(opts);
  filters.push(f);
  return f;
}

afterEach(async () => {
  await Promise.all(filters.splice(0).map((f) => f.close()));
});

describe('RegexFilter', () => {
  it('says which texts match', async () => {
    expect(await filter().match('b+', ['abc', 'xyz', 'bb'])).toEqual({
      ok: true,
      matches: [true, false, true],
    });
  });

  it('calls a run over budget too slow', async () => {
    const out = await filter({ budgetMs: 100 }).match('(a|a)*b', ['a'.repeat(4000)]);
    expect(out).toEqual({ ok: false, reason: 'slow' });
  });

  it("tells a regex that couldn't run apart from a slow one", async () => {
    const f = filter({
      createWorker: () => {
        throw new Error('ERR_WORKER_INIT_FAILED');
      },
    });
    expect(await f.match('a', ['a'])).toEqual({ ok: false, reason: 'failed' });
  });
});
