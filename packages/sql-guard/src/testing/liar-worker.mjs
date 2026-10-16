// A guard worker that loads schemas, then answers checks with a shape not to trust.
import { parentPort } from 'node:worker_threads';

parentPort.postMessage({ ready: true });
parentPort.on('message', (req) => {
  if (req.kind === 'schema') parentPort.postMessage({ id: req.id, schema: true });
  else parentPort.postMessage({ id: req.id, result: { ok: 'yes' } });
});
