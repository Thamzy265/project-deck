// A guard worker that never says it is ready.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', () => undefined);
