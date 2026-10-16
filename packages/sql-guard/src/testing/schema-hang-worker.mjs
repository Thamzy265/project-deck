// A guard worker that never finishes loading a schema.
import { parentPort } from 'node:worker_threads';

parentPort.postMessage({ ready: true });
parentPort.on('message', () => undefined);
