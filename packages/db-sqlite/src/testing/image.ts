import { loadSqlite } from '../sqlite.js';

/** A database file image made by running `sql` in a fresh in-memory database. */
export async function imageFromSql(sql: string): Promise<Buffer> {
  const sqlite = await loadSqlite();
  const db = new sqlite.oo1.DB();
  try {
    db.exec(sql);
    return Buffer.from(sqlite.capi.sqlite3_js_db_export(db.pointer ?? 0));
  } finally {
    db.close();
  }
}
