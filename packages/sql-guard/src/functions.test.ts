import { describe, expect, it } from 'vitest';
import { loadSqlite } from './engine.js';
import { BUILTIN_FUNCTIONS, DENIED_FUNCTIONS } from './functions.js';

describe('function allowlist', () => {
  it('names only functions the bundled SQLite really has', async () => {
    const sqlite = await loadSqlite();
    const db = new sqlite.oo1.DB(':memory:', 'c');
    try {
      const known = new Set(db.selectValues('SELECT name FROM pragma_function_list'));
      const missing = [...BUILTIN_FUNCTIONS].filter((name) => !known.has(name));
      expect(missing).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('shares no name with the deny list', () => {
    expect([...DENIED_FUNCTIONS].filter((name) => BUILTIN_FUNCTIONS.has(name))).toEqual([]);
  });
});
