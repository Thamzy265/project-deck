/**
 * The snapshot engine's worker thread: owns the wasm engine and the open image, so a
 * read that runs too long or grows too big is stopped by terminating the thread
 * (design review S2: sql.js-style reads run in a terminable worker).
 */
import { parentPort } from 'node:worker_threads';
import { isDbError } from '@project-deck/core';
import type { OpenDb } from './ops.js';
import { closeImage, hashes, openImage, query, rowsByKey, schema, sqlSchema } from './ops.js';
import { loadSqlite } from './sqlite.js';

type Request =
  | { id: number; op: 'open'; bytes: Uint8Array }
  | { id: number; op: 'schema' }
  | { id: number; op: 'sqlSchema' }
  | { id: number; op: 'query'; sql: string; params: unknown[]; limit: number }
  | { id: number; op: 'hashes' }
  | { id: number; op: 'rows'; table: string; keys: never[] };

const port = parentPort;
if (port === null) throw new Error('The snapshot worker must run in a worker thread');
const sqlite = await loadSqlite();
let open: OpenDb | undefined;

function needOpen(): OpenDb {
  if (open === undefined) throw new Error('No copy is open');
  return open;
}

function run(req: Request): unknown {
  switch (req.op) {
    case 'open':
      if (open !== undefined) closeImage(open);
      open = undefined;
      open = openImage(sqlite, req.bytes);
      return true;
    case 'schema':
      return schema(needOpen());
    case 'sqlSchema':
      return sqlSchema(needOpen());
    case 'query':
      return query(needOpen(), req.sql, req.params, req.limit);
    case 'hashes':
      return hashes(needOpen());
    case 'rows':
      return rowsByKey(needOpen(), req.table, req.keys);
  }
}

port.on('message', (req: Request) => {
  try {
    port.postMessage({ id: req.id, ok: true, value: run(req) });
  } catch (err) {
    // Only a DbError's code and words cross over: other errors may quote row data.
    port.postMessage(
      isDbError(err)
        ? { id: req.id, ok: false, code: err.code, message: err.message }
        : { id: req.id, ok: false, code: 'internal', message: 'The snapshot engine failed.' },
    );
  }
});
port.postMessage({ ready: true });
