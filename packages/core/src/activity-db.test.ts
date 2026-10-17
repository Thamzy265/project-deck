import { describe, expect, it } from 'vitest';
import { ActivityEntrySchema } from './activity.js';

describe('ActivityEntrySchema: database entries', () => {
  it('accepts snapshot, diff and write entries with table names and a change count only', () => {
    const entries = [
      { id: 1, ts: 1, kind: 'db.snapshot', db: 'app' },
      { id: 2, ts: 2, kind: 'db.diff', db: 'app' },
      { id: 3, ts: 3, kind: 'db.write', db: 'app', tables: ['orders'], allowed: true, changes: 1 },
      { id: 4, ts: 4, kind: 'db.write', db: 'app', tables: ['orders'], allowed: false },
    ];
    for (const entry of entries) expect(ActivityEntrySchema.parse(entry)).toEqual(entry);
  });

  it('never keeps the SQL of an edit', () => {
    const entry = ActivityEntrySchema.parse({
      id: 1,
      ts: 1,
      kind: 'db.write',
      db: 'app',
      tables: ['orders'],
      allowed: true,
      changes: 1,
      sql: 'DELETE FROM orders',
    });
    expect(entry).not.toHaveProperty('sql');
  });

  it('bounds names and counts', () => {
    const base = { id: 1, ts: 1, kind: 'db.write', db: 'app', allowed: true };
    expect(ActivityEntrySchema.safeParse({ ...base, tables: Array(65).fill('t') }).success).toBe(
      false,
    );
    expect(ActivityEntrySchema.safeParse({ ...base, tables: [], changes: -1 }).success).toBe(false);
    expect(
      ActivityEntrySchema.safeParse({ id: 1, ts: 1, kind: 'db.diff', db: 'x'.repeat(301) }).success,
    ).toBe(false);
  });
});
