// A guard worker that answers with a shape the guard must not trust.
import { parentPort } from 'node:worker_threads';

parentPort.postMessage({ ready: true });
parentPort.on('message', (req) => parentPort.postMessage({ id: req.id, result: { ok: 'yes' } }));
