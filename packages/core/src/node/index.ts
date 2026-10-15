/**
 * Node-only helpers shared by the daemon and its clients: files under `.flutterdeck/`
 * and the per-user registry. A separate entry, so the browser dashboard never pulls in
 * `node:` modules through the main one.
 */
export * from './budgeted-worker.js';
export * from './fs-retry.js';
export * from './config-file.js';
export * from './project-id.js';
export * from './runtime.js';
export { NotRegularFileError, StateDirError, checkStateDir, readRegularFile } from './safe-file.js';
