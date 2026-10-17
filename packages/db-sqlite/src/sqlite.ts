import type { Sqlite3Static } from '@sqlite.org/sqlite-wasm';

export type Sqlite3 = Sqlite3Static;

let loading: Promise<Sqlite3> | undefined;

/**
 * Loads the bundled SQLite wasm (Apache-2.0, pure wasm, no native module), the same
 * engine as the read-only gate. The node build reads it from disk, never the network.
 */
export function loadSqlite(): Promise<Sqlite3> {
  loading ??= import('@sqlite.org/sqlite-wasm').then(({ default: init }) => init());
  return loading;
}
