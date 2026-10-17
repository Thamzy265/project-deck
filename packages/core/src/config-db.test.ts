import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  DeckConfigSchema,
  MAX_HIDDEN_COLUMNS,
  parseHiddenColumn,
} from './config.js';

describe('database settings in config.json', () => {
  it('default to writes off and no hidden columns', () => {
    expect(DEFAULT_CONFIG.db).toEqual({ allowWrites: false, hiddenColumns: [] });
    expect(DEFAULT_CONFIG.android).toBeUndefined();
    expect(DEFAULT_CONFIG.ios).toBeUndefined();
  });

  it('accept hidden columns as table.column, the app id and the bundle id', () => {
    const parsed = DeckConfigSchema.parse({
      version: 1,
      db: { allowWrites: true, hiddenColumns: ['users.email', 'users.password_hash'] },
      android: { applicationId: 'com.example.shop' },
      ios: { bundleId: 'com.example.Shop-Dev' },
    });
    expect(parsed.db.hiddenColumns).toEqual(['users.email', 'users.password_hash']);
    expect(parsed.android?.applicationId).toBe('com.example.shop');
    expect(parsed.ios?.bundleId).toBe('com.example.Shop-Dev');
  });

  it('refuse malformed hidden columns, ids and unknown keys', () => {
    for (const bad of [
      { db: { hiddenColumns: ['email'] } },
      { db: { hiddenColumns: ['.email'] } },
      { db: { hiddenColumns: ['users.'] } },
      {
        db: { hiddenColumns: Array.from({ length: MAX_HIDDEN_COLUMNS + 1 }, (_, i) => `t.c${i}`) },
      },
      { db: { allowWrites: 'yes' } },
      { db: { allowFunctions: true } },
      { android: { applicationId: 'shop' } },
      { android: { applicationId: 'com.example.shop; rm -rf /' } },
      { android: { applicationId: '-com.example' } },
      { ios: { bundleId: '-com.example' } },
      { ios: { bundleId: 'com.example/../x' } },
      { ios: { bundleId: 'com.example', udid: 'x' } },
    ]) {
      expect(DeckConfigSchema.safeParse({ version: 1, ...bad }).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
  });

  it('splits a hidden column at the first dot', () => {
    expect(parseHiddenColumn('users.email')).toEqual({ table: 'users', column: 'email' });
    expect(parseHiddenColumn('users.meta.json')).toEqual({ table: 'users', column: 'meta.json' });
  });
});
