/**
 * The guard's worker thread: owns the wasm engine so a slow prepare can be cut off by
 * terminating the thread (ADR 0005 amended: 10 s init, 1 s per check).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { GuardEngine, loadSqlite } from './engine.js';
import type { GuardCheckOptions } from './types.js';

type Request =
  | { id: number; kind: 'schema'; key: string; schemaSql: readonly string[] }
  | {
      id: number;
      kind: 'check';
      key: string;
      sql: string;
      opts: Omit<GuardCheckOptions, 'schemaSql'>;
    };

const port = parentPort;
if (port === null) throw new Error('The SQL guard worker must run in a worker thread');
const data = workerData as { maxSchemas?: unknown } | undefined;
const maxSchemas = typeof data?.maxSchemas === 'number' ? data.maxSchemas : undefined;
const engine = new GuardEngine(await loadSqlite(), maxSchemas === undefined ? {} : { maxSchemas });

port.on('message', (req: Request) => {
  try {
    if (req.kind === 'schema') {
      // A refused schema stays cached too; its refusal answers every check.
      engine.loadSchema(req.schemaSql, req.key);
      port.postMessage({ id: req.id, schema: true });
    } else {
      const result = engine.checkLoaded(req.key, req.sql, req.opts);
      port.postMessage(
        result === undefined ? { id: req.id, missing: true } : { id: req.id, result },
      );
    }
  } catch {
    port.postMessage({ id: req.id, failed: true });
  }
});
port.postMessage({ ready: true });
