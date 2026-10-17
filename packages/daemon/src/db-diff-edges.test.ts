/**
 * Tester probes for the diff (design note D5, D6, S3): hidden columns when a backend
 * answers rows in another column order, Claude's table cap with tables in error, and
 * whether Claude is told that tables were left out.
 * Tests marked `it.fails` (DB-n) are repros of open tester findings: they turn into
 * plain `it` tests when the fix lands.
 */
import type {
  DbInspector,
  DeckEvents,
  KeyedRows,
  RowHashes,
  RowKey,
  TableInfo,
} from '@project-deck/core';
import { DbDiffResponse, EventBus, Registry } from '@project-deck/core';
import { FakeAppSession, fakeApp } from '@project-deck/core/testing';
import { FakeSqlGuard } from '@project-deck/sql-guard/testing';
import { describe, expect, it } from 'vitest';
import { CLAUDE_DIFF_CAPS, HIDDEN, buildDiff } from './db-diff.js';
import { DbService } from './db-service.js';

const H = (n: number): string => n.toString(16).padStart(16, '0');

/** An inspector made of two hash snapshots and a rowsByKey answer, for buildDiff. */
function inspectorWith(
  rows: (table: string, keys: RowKey[]) => KeyedRows,
  hashes: RowHashes[] = [],
): DbInspector {
  let n = 0;
  return {
    id: 'probe',
    live: true,
    writable: false,
    listDatabases: () => Promise.resolve([{ name: 'app', backend: 'live' }]),
    schema: () => Promise.resolve([] as TableInfo[]),
    schemaSql: () => Promise.resolve([]),
    query: () => Promise.reject(new Error('unused')),
    rowHashes: () => {
      const h = hashes[Math.min(n++, hashes.length - 1)];
      return h === undefined ? Promise.reject(new Error('no hashes')) : Promise.resolve(h);
    },
    rowsByKey: (_db, table, keys) => Promise.resolve(rows(table, keys)),
  };
}

const usersBefore: RowHashes = {
  takenAt: 1,
  tables: [{ name: 'users', columns: ['id', 'email', 'name'], key: ['id'], rows: [] }],
};
const usersAfter: RowHashes = {
  takenAt: 2,
  tables: [
    {
      name: 'users',
      columns: ['id', 'email', 'name'],
      key: ['id'],
      rows: [[1, [H(1), H(2), H(3)]]],
    },
  ],
};

describe('buildDiff hidden columns (tester probes)', () => {
  it('DB-1: drops the hidden column by name even when rowsByKey answers columns in another order', async () => {
    // The app's `rows` reply names its own column order (KeyedRows.columns). A schema
    // change between the two calls, or a backend that orders columns differently,
    // must not shift a hidden value into a visible slot.
    const inspector = inspectorWith(() => ({
      columns: ['id', 'name', 'email'],
      key: ['id'],
      rows: [[1, [1, 'Ann', 'ann@example.com']]],
      missing: [],
      truncated: false,
    }));
    const { tables } = await buildDiff(
      inspector,
      'app',
      usersBefore,
      usersAfter,
      CLAUDE_DIFF_CAPS,
      [{ table: 'users', column: 'email' }],
    );
    const text = JSON.stringify(tables);
    expect(text).not.toContain('ann@example.com');
    expect(tables[0]?.columns).toEqual(['id', 'name']);
    expect(tables[0]?.added[0]?.row).toEqual([1, 'Ann']);
  });

  it('hides the whole key when any part of a composite key is hidden', async () => {
    const before: RowHashes = {
      takenAt: 1,
      tables: [
        { name: 'Members', columns: ['org', 'email', 'role'], key: ['org', 'email'], rows: [] },
      ],
    };
    const after: RowHashes = {
      takenAt: 2,
      tables: [
        {
          name: 'Members',
          columns: ['org', 'email', 'role'],
          key: ['org', 'email'],
          rows: [
            [
              [7, 'ann@example.com'],
              [H(1), H(2), H(3)],
            ],
          ],
        },
      ],
    };
    const inspector = inspectorWith(() => ({
      columns: ['org', 'email', 'role'],
      key: ['org', 'email'],
      rows: [
        [
          [7, 'ann@example.com'],
          [7, 'ann@example.com', 'admin'],
        ],
      ],
      missing: [],
      truncated: false,
    }));
    // Config written in another letter case than the schema: SQLite folds ASCII names.
    const { tables } = await buildDiff(inspector, 'app', before, after, CLAUDE_DIFF_CAPS, [
      { table: 'MEMBERS', column: 'Email' },
    ]);
    expect(JSON.stringify(tables)).not.toContain('ann@example.com');
    expect(tables[0]?.added[0]?.key).toBe(HIDDEN);
  });

  it("DB-7: keeps tables in error within Claude's 20-table cap", async () => {
    const tables = Array.from({ length: 30 }, (_, i) => ({
      name: `t${i}`,
      error: { code: 'too-large', message: `Too large to compare: t${i}` },
    }));
    const snap: RowHashes = { takenAt: 1, tables };
    const inspector = inspectorWith(() => {
      throw new Error('unused');
    });
    const out = await buildDiff(inspector, 'app', snap, snap, CLAUDE_DIFF_CAPS, []);
    expect(out.tables.length).toBeLessThanOrEqual(CLAUDE_DIFF_CAPS.tables);
  });
});

describe('DbService.diff truncation (tester probes)', () => {
  it('DB-6: tells Claude when tables were left out by the 20-table cap', async () => {
    const names = Array.from({ length: 25 }, (_, i) => `t${String(i).padStart(2, '0')}`);
    const empty: RowHashes = {
      takenAt: 1,
      tables: names.map((name) => ({ name, columns: ['id'], key: ['id'], rows: [] })),
    };
    const full: RowHashes = {
      takenAt: 2,
      tables: names.map((name) => ({ name, columns: ['id'], key: ['id'], rows: [[1, [H(1)]]] })),
    };
    const inspector = inspectorWith(
      (_t, keys) => ({
        columns: ['id'],
        key: ['id'],
        rows: keys.map((k) => [k, [k as number]] as [RowKey, number[]]),
        missing: [],
        truncated: false,
      }),
      [empty, full],
    );
    const registry = new Registry();
    registry.dbInspectors.register({ id: inspector.id, create: () => Promise.resolve(inspector) });
    const service = new DbService({
      registry,
      bus: new EventBus<DeckEvents>(),
      guard: new FakeSqlGuard(),
      settings: { allowWrites: false, hiddenColumns: [] },
    });
    const app = fakeApp();
    await service.attach(app, new FakeAppSession(app));
    const snap = await service.snapshot({ db: 'app' });
    const diff = await service.diff({ db: 'app', snapshotId: snap.id }, 'claude');
    await service.close();
    expect(DbDiffResponse.safeParse(diff).success).toBe(true);
    expect(diff.tables).toHaveLength(20);
    // 5 changed tables are not in the answer: the answer must say so.
    expect(diff).toHaveProperty('truncated', true);
  });
});
