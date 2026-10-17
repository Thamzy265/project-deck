import { describe, expect, it } from 'vitest';
import { DbEditConfirmInput, DbExecuteInput, DbQueryInput } from './api.js';

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
