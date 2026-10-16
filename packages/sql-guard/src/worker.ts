/**
 * The guard's worker thread: owns the wasm engine so a slow prepare can be cut off by
 * terminating the thread (ADR 0005 amended: 10 s init, 1 s per check).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { GuardEngine, loadSqlite } from './engine.js';
import type { GuardCheckOptions } from './types.js';

type Request =
  | { id: number; kind: 'schema'; schemaSql: readonly string[] }
  | { id: number; kind: 'check'; sql: string; opts: GuardCheckOptions };

const port = parentPort;
if (port === null) throw new Error('The SQL guard worker must run in a worker thread');
const data = workerData as { maxSchemas?: unknown } | undefined;
const maxSchemas = typeof data?.maxSchemas === 'number' ? data.maxSchemas : undefined;
const engine = new GuardEngine(await loadSqlite(), maxSchemas === undefined ? {} : { maxSchemas });

port.on('message', (req: Request) => {
  try {
    if (req.kind === 'schema') {
      const refusal = engine.loadSchema(req.schemaSql);
      port.postMessage(
        refusal === undefined ? { id: req.id, schema: true } : { id: req.id, result: refusal },
      );
    } else {
      port.postMessage({ id: req.id, result: engine.check(req.sql, req.opts) });
    }
  } catch {
    port.postMessage({ id: req.id, failed: true });
  }
});
port.postMessage({ ready: true });
