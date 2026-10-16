// A guard worker that counts schema loads and reports, in `tables`, how many it has had
// and whether a check message carried the schema again. SQL 'FORGET' drops its schemas.
import { parentPort } from 'node:worker_threads';

const schemas = new Set();
let loads = 0;
parentPort.postMessage({ ready: true });
parentPort.on('message', (req) => {
  if (req.kind === 'schema') {
    loads++;
    schemas.add(req.key);
    parentPort.postMessage({ id: req.id, schema: true });
    return;
  }
  if (req.sql === 'FORGET' && loads === 1) schemas.clear();
  if (!schemas.has(req.key)) {
    parentPort.postMessage({ id: req.id, missing: true });
    return;
  }
  parentPort.postMessage({
    id: req.id,
    result: {
      ok: true,
      kind: 'select',
      tables: [`loads:${loads}`, `schema-in-check:${'schemaSql' in req}`],
      functions: [],
      recursive: false,
    },
  });
});
