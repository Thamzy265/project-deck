import { describe, expect, it } from 'vitest';
import {
  DbDiffInput,
  DbEditConfirmInput,
  DbExecuteInput,
  DbQueryInput,
  DbSchemaInput,
  DbSnapshotInput,
  McpDbQueryInput,
} from './api.js';

describe('SQL parameters', () => {
  it('take integers past 2^53 as tagged ints, so a key binds as an integer (TAB-2)', () => {
    const big = { type: 'int', value: '9007199254740993' };
    for (const schema of [DbQueryInput, DbExecuteInput]) {
      expect(schema.parse({ db: 'app', sql: 'SELECT ?', params: [big] }).params).toEqual([big]);
    }
    expect(
      DbEditConfirmInput.parse({ requestId: 'a'.repeat(32), sql: 'x', params: [big] }).params,
    ).toEqual([big]);
  });

  it('take the whole 64-bit range and nothing past it (review R5)', () => {
    const at = (value: string) =>
      DbExecuteInput.safeParse({ db: 'app', sql: 'x', params: [{ type: 'int', value }] }).success;
    expect(at('9223372036854775807')).toBe(true);
    expect(at('-9223372036854775808')).toBe(true);
    expect(at('9223372036854775808')).toBe(false);
    expect(at('-9223372036854775809')).toBe(false);
    expect(at('99999999999999999999')).toBe(false);
  });

  it('refuse other objects and malformed tagged ints', () => {
    for (const bad of [
      { type: 'int', value: '1.5' },
      { type: 'int', value: 'x' },
      { type: 'blob', base64: 'AA==' },
      { type: 'real', value: 'NaN' },
      {},
    ]) {
      expect(DbExecuteInput.safeParse({ db: 'app', sql: 'x', params: [bad] }).success).toBe(false);
    }
  });
});

describe('database names (MCP-5)', () => {
  it('refuse "." and "..", which a URL path folds away', () => {
    for (const db of ['.', '..']) {
      expect(DbSchemaInput.safeParse({ db }).success, db).toBe(false);
      expect(McpDbQueryInput.safeParse({ db, sql: 'SELECT 1' }).success, db).toBe(false);
      expect(DbSnapshotInput.safeParse({ db }).success, db).toBe(false);
      expect(DbDiffInput.safeParse({ db }).success, db).toBe(false);
    }
  });

  it('take names with dots and slashes, such as snapshot paths', () => {
    for (const db of ['app', '...', '.hidden', 'app_flutter/app.sqlite', 'a..b']) {
      expect(DbSchemaInput.safeParse({ db }).success, db).toBe(true);
    }
  });
});
