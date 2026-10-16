// A guard worker that follows the SQL it is asked about: HANG never answers, CRASH
// exits mid-check, LATE answers after 200 ms; anything else passes at once.
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { parentPort } from 'node:worker_threads';

const ok = { ok: true, kind: 'select', tables: [], functions: [], recursive: false };
parentPort.postMessage({ ready: true });
parentPort.on('message', (req) => {
  if (req.kind === 'schema') {
    parentPort.postMessage({ id: req.id, schema: true });
  } else if (req.sql === 'CRASH') {
    process.exit(3);
  } else if (req.sql === 'LATE') {
    setTimeout(() => parentPort.postMessage({ id: req.id, result: ok }), 200);
  } else if (req.sql !== 'HANG') {
    parentPort.postMessage({ id: req.id, result: { ...ok, tables: [req.sql] } });
  }
});
