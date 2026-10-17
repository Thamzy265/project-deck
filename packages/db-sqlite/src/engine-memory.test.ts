import { afterEach, describe, expect, it } from 'vitest';
import { SnapshotEngine } from './engine.js';
import { plainDbFixture } from './testing/fixtures.js';

const BUILT_WORKER = new URL('../dist/worker.js', import.meta.url);
const MB = 1024 * 1024;
let engine: SnapshotEngine | undefined;

afterEach(async () => {
  await engine?.close();
  engine = undefined;
});

/** Runs `work` and samples this process's RSS (worker threads included) meanwhile. */
async function peakRss<T>(
  work: () => Promise<T>,
): Promise<{ result: PromiseSettledResult<T>; growth: number }> {
  const before = process.memoryUsage().rss;
  let peak = before;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 20);
  const [result] = await Promise.allSettled([work()]);
  clearInterval(timer);
  peak = Math.max(peak, process.memoryUsage().rss);
  return { result, growth: peak - before };
}

describe('SnapshotEngine memory (R4)', { timeout: 60_000 }, () => {
  it("keeps the reviewer's 50 x 16 MB query within a memory bound", async () => {
    engine = new SnapshotEngine({ workerUrl: BUILT_WORKER, budgetMs: 30_000 });
    engine.load(plainDbFixture());
    const cols = Array.from({ length: 50 }, (_, i) => `printf('%.*c',16000000,'x') AS c${i}`).join(
      ', ',
    );
    const e = engine;
    const { result, growth } = await peakRss(() => e.query(`SELECT ${cols}`, [], 1));
    expect(growth / MB).toBeLessThan(600);
    if (result.status === 'fulfilled') {
      // Whatever came back fits the 8 MB reply cap and says it was cut.
      expect(JSON.stringify(result.value.rows).length).toBeLessThan(9 * MB);
      expect(result.value.truncated).toBe(true);
    } else {
      expect(result.reason).toMatchObject({ code: 'too-large' });
    }
    // The engine still answers afterwards.
    expect((await e.query('SELECT count(*) FROM orders', [], 1)).rows).toEqual([[2]]);
  });

  it('stops a row at the 8 MB reply budget instead of reading every cell', async () => {
    engine = new SnapshotEngine({ workerUrl: BUILT_WORKER });
    engine.load(plainDbFixture());
    const cols = Array.from({ length: 3 }, (_, i) => `printf('%.*c',5000000,'x') AS c${i}`).join(
      ', ',
    );
    const result = await engine.query(`SELECT ${cols}`, [], 10);
    expect(result.rows).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  it('sends only the first 64 kB of a large blob, with its full size', async () => {
    engine = new SnapshotEngine({ workerUrl: BUILT_WORKER });
    engine.load(plainDbFixture());
    const result = await engine.query('SELECT zeroblob(10000000) AS b', [], 1);
    const [cell] = result.rows[0] ?? [];
    expect(cell).toMatchObject({ type: 'blob', bytes: 10_000_000, truncated: true });
    expect((cell as { base64: string }).base64.length).toBeLessThan(90_000);
  });
});
