/**
 * Tester probe: `get_logs` passes Claude's `regex` to the daemon, which validates it with
 * GetLogsInput and runs it in RingBufferLogSource.query on its only thread. A log line
 * can ask Claude to use a pattern, so the pattern is attacker-influenced. The check runs
 * in a worker thread from the built package, so a hang ends the worker, not the suite.
 */
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';

const BUDGET_MS = 1000;

/** Validates like the daemon does, then queries one hostile line; reports how it ended. */
const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
import(workerData.core).then(async ({ GetLogsInput, RingBufferLogSource }) => {
  const parsed = GetLogsInput.safeParse({ regex: workerData.regex });
  if (!parsed.success) return parentPort.postMessage('refused');
  const logs = new RingBufferLogSource(10);
  logs.push({ ts: 1, level: 'info', source: 'app', message: workerData.message });
  await logs.query(parsed.data);
  parentPort.postMessage('answered');
});
`;

function runQuery(regex: string, message: string): Promise<'refused' | 'answered' | 'hung'> {
  const core = new URL('../dist/index.js', import.meta.url).href;
  const worker = new Worker(WORKER, { eval: true, workerData: { core, regex, message } });
  worker.on('error', () => undefined);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve('hung');
    }, BUDGET_MS);
    worker.once('message', (msg: 'refused' | 'answered') => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(msg);
    });
  });
}

describe('get_logs regex on the daemon thread', () => {
  it('answers quickly for an ordinary pattern', async () => {
    expect(await runQuery('timeout|refused', 'connection refused')).toBe('answered');
  });

  it.fails(
    'BUG-MCP-T2: refuses or bounds a catastrophic pattern instead of hanging the daemon',
    async () => {
      // 40 characters is enough: (a+)+$ backtracks 2^40 times on a line with no match.
      expect(await runQuery('(a+)+$', `${'a'.repeat(40)}!`)).not.toBe('hung');
    },
  );
});
