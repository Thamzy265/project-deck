// A guard worker that loads schemas at once, then never answers a check.
import { parentPort } from 'node:worker_threads';

parentPort.postMessage({ ready: true });
parentPort.on('message', (req) => {
  if (req.kind === 'schema') parentPort.postMessage({ id: req.id, schema: true });
});
