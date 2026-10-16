// A guard worker that says it is ready, then never answers a check.
import { parentPort } from 'node:worker_threads';

parentPort.postMessage({ ready: true });
parentPort.on('message', () => undefined);
