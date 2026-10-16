// A guard worker whose schema load takes 300 ms and whose checks answer at once.
import { setTimeout } from 'node:timers';
import { parentPort } from 'node:worker_threads';

const ok = { ok: true, kind: 'select', tables: [], functions: [], recursive: false };
parentPort.postMessage({ ready: true });
parentPort.on('message', (req) => {
  if (req.kind === 'schema') {
    setTimeout(() => parentPort.postMessage({ id: req.id, schema: true }), 300);
  } else {
    parentPort.postMessage({ id: req.id, result: ok });
  }
});
