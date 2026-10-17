/**
 * Review R1 (privacy): Claude's diff must hide what the gate hides, not only the
 * hiddenColumns names: generated columns computed from a hidden column (STORED and
 * VIRTUAL) and FTS tables while any column is hidden. Real gate, both backends.
 */
import type { DbInspector, DbInspectorFactory, DeckEvents, RowHashes } from '@project-deck/core';
import { EventBus, Registry } from '@project-deck/core';
import { FakeAppSession, fakeApp } from '@project-deck/core/testing';
import { DriftInspector } from '@project-deck/db-drift';
import { FakeDriftApp } from '@project-deck/db-drift/testing';
import { SqliteSnapshotInspector } from '@project-deck/db-sqlite';
import { FakeSnapshotSource, imageFromSql } from '@project-deck/db-sqlite/testing';
import type { SqlGuard } from '@project-deck/sql-guard';
import { createSqlGuard } from '@project-deck/sql-guard';
import { FakeSqlGuard } from '@project-deck/sql-guard/testing';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { DbService } from './db-service.js';

const realGuard = createSqlGuard();
afterAll(async () => {
  await realGuard.close();
});
const services: DbService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()));
});

const SCHEMA = [
  'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT, email_lower TEXT GENERATED ALWAYS AS (lower(email)) STORED, email_upper TEXT GENERATED ALWAYS AS (upper(email)) VIRTUAL)',
  // External content over users: it indexes the hidden users.email (ADR 0005 amended).
  "CREATE VIRTUAL TABLE notes USING fts5(email, content='users', content_rowid='id')",
];
const HIDDEN = { allowWrites: false, hiddenColumns: ['users.email'] };

async function serviceFor(inspector: DbInspector, guard: SqlGuard = realGuard): Promise<DbService> {
  const registry = new Registry();
  const factory: DbInspectorFactory = {
    id: inspector.id,
    create: () => Promise.resolve(inspector),
  };
  registry.dbInspectors.register(factory);
  const service = new DbService({
    registry,
    bus: new EventBus<DeckEvents>(),
    guard,
    settings: HIDDEN,
  });
  services.push(service);
  const app = fakeApp();
  await service.attach(app, new FakeAppSession(app));
  return service;
}

const H = (n: number): string => n.toString(16).padStart(16, '0');

/** A flutterdeck_drift app whose hashes change between two snapshot calls. */
function driftApp(): FakeDriftApp {
  const users = ['id', 'name', 'email', 'email_lower', 'email_upper'];
  const before: RowHashes = {
    takenAt: 1,
    tables: [
      { name: 'notes', columns: ['email'], key: ['rowid'], rowid: true, rows: [[1, [H(1)]]] },
      { name: 'users', columns: users, key: ['id'], rows: [[1, [H(1), H(2), H(3), H(4), H(5)]]] },
    ],
  };
  const after: RowHashes = {
    takenAt: 2,
    tables: [
      {
        name: 'notes',
        columns: ['email'],
        key: ['rowid'],
        rowid: true,
        rows: [
          [1, [H(1)]],
          [2, [H(9)]],
        ],
      },
      {
        name: 'users',
        columns: users,
        key: ['id'],
        rows: [
          [1, [H(1), H(2), H(6), H(7), H(8)]],
          [2, [H(10), H(11), H(12), H(13), H(14)]],
        ],
      },
    ],
  };
  let snapshots = 0;
  const app = new FakeDriftApp();
  app.handle('schema', () => ({ tables: [], sqlSchema: SCHEMA }));
  app.handle('snapshot', () => (snapshots++ === 0 ? before : after));
  app.handle('rows', (p) =>
    p.table === 'notes'
      ? {
          columns: ['email'],
          key: ['rowid'],
          rowid: true,
          rows: [[2, ['bo@example.com']]],
          missing: [],
          truncated: false,
        }
      : {
          columns: users,
          key: ['id'],
          rows: [
            [1, [1, 'Ann', 'ann.new@example.com', 'ann.new@example.com', 'ANN.NEW@EXAMPLE.COM']],
            [2, [2, 'Bo', 'bo@example.com', 'bo@example.com', 'BO@EXAMPLE.COM']],
          ],
          missing: [],
          truncated: false,
        },
  );
  return app;
}

const SEED = `${SCHEMA.join(';\n')};
INSERT INTO users (id, name, email) VALUES (1, 'Ann', 'ann@example.com');
INSERT INTO notes (rowid, email) VALUES (1, 'ann@example.com');`;
const NAME = 'app_flutter/app.sqlite';

describe("Claude's diff hides what the gate hides (R1)", { timeout: 30_000 }, () => {
  it('live backend: generated columns of a hidden column and the FTS table stay hidden', async () => {
    const service = await serviceFor(new DriftInspector(driftApp().extensions));
    const snap = await service.snapshot({ db: 'app' });
    const diff = await service.diff({ db: 'app', snapshotId: snap.id }, 'claude');
    expect(JSON.stringify(diff)).not.toMatch(/example\.com/i);
    expect(diff.tables.map((t) => t.table)).toEqual(['users']);
    const [users] = diff.tables;
    expect(users?.columns).toEqual(['id', 'name']);
    // Ann changed only in hidden columns: not shown, not counted.
    expect(users?.changed).toEqual([]);
    expect(users?.added).toEqual([{ key: 2, row: [2, 'Bo'] }]);
    // The dashboard still sees everything.
    const full = await service.diff({ db: 'app', snapshotId: snap.id }, 'dashboard');
    expect(JSON.stringify(full)).toMatch(/example\.com/);
  });

  it('snapshot backend: the same, on a real database file', async () => {
    const source = new FakeSnapshotSource({ [NAME]: await imageFromSql(SEED) });
    const service = await serviceFor(new SqliteSnapshotInspector(() => Promise.resolve(source)));
    const snap = await service.snapshot({ db: NAME });
    source.files[NAME] = await imageFromSql(`${SEED}
      UPDATE users SET email = 'ann.new@example.com' WHERE id = 1;
      INSERT INTO users (id, name, email) VALUES (2, 'Bo', 'bo@example.com');
      INSERT INTO notes (rowid, email) VALUES (2, 'bo@example.com');`);
    const diff = await service.diff({ db: NAME, snapshotId: snap.id }, 'claude');
    expect(JSON.stringify(diff)).not.toMatch(/example\.com/i);
    const users = diff.tables.find((t) => t.table === 'users');
    expect(users?.columns).toEqual(['id', 'name']);
    expect(users?.changed).toEqual([]);
    expect(users?.added).toEqual([{ key: 2, row: [2, 'Bo'] }]);
    expect(diff.tables.some((t) => t.table.startsWith('notes'))).toBe(false);
  });

  it('fails closed when the gate cannot answer: the table is left out and the diff says so', async () => {
    const down = new FakeSqlGuard(() => ({ ok: false, code: 'unavailable', reason: 'down' }));
    const service = await serviceFor(new DriftInspector(driftApp().extensions), down);
    const snap = await service.snapshot({ db: 'app' });
    const diff = await service.diff({ db: 'app', snapshotId: snap.id }, 'claude');
    expect(JSON.stringify(diff)).not.toMatch(/example\.com/i);
    expect(diff.tables).toEqual([]);
    expect(diff.truncated).toBe(true);
  });
});

describe("Claude's diff when the schema changed at runtime (L1)", { timeout: 30_000 }, () => {
  // Before the migration users has no hidden column, so SELECT * passes on this schema.
  const V1 = ['CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)'];
  const V2 = [
    'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, ssn TEXT, ssn_last4 TEXT GENERATED ALWAYS AS (substr(ssn, -4)) STORED)',
  ];
  const cols = ['id', 'name', 'ssn', 'ssn_last4'];

  /** An app whose schema is V1 until `migrate()`, with ssn_last4 in its hashes. */
  function app(schemaAfter: string[]) {
    let schema = V1;
    let snapshots = 0;
    const drift = new FakeDriftApp();
    drift.handle('schema', () => ({ tables: [], sqlSchema: schema }));
    drift.handle('snapshot', () => ({
      takenAt: snapshots,
      tables: [
        {
          name: 'users',
          columns: cols,
          key: ['id'],
          rows: [[1, snapshots++ === 0 ? [H(1), H(2), H(3), H(4)] : [H(1), H(2), H(5), H(6)]]],
        },
      ],
    }));
    drift.handle('rows', () => ({
      columns: cols,
      key: ['id'],
      rows: [[1, [1, 'Ann', '123-45-6789', '6789']]],
      missing: [],
      truncated: false,
    }));
    return {
      drift,
      migrate: () => {
        schema = schemaAfter;
      },
    };
  }

  async function diffAfterMigration(schemaAfter: string[]) {
    const { drift, migrate } = app(schemaAfter);
    const registry = new Registry();
    const inspector = new DriftInspector(drift.extensions);
    registry.dbInspectors.register({ id: 'drift', create: () => Promise.resolve(inspector) });
    const service = new DbService({
      registry,
      bus: new EventBus<DeckEvents>(),
      guard: realGuard,
      settings: { allowWrites: false, hiddenColumns: ['users.ssn'] },
    });
    services.push(service);
    const fake = fakeApp();
    await service.attach(fake, new FakeAppSession(fake));
    // A first query caches the V1 schema for the gate.
    await service.query({ db: 'app', sql: 'SELECT id, name FROM users' }, 'claude');
    const snap = await service.snapshot({ db: 'app' });
    migrate();
    return service.diff({ db: 'app', snapshotId: snap.id }, 'claude');
  }

  it('reads the schema fresh, so a generated column of a hidden one added at runtime stays hidden', async () => {
    const diff = await diffAfterMigration(V2);
    expect(JSON.stringify(diff)).not.toMatch(/6789/);
    expect(diff.tables).toEqual([]);
  });

  it("treats a hash column the gate's schema doesn't know as hidden", async () => {
    // The app's schema reply lags behind its data: the column is unknown to the gate.
    const diff = await diffAfterMigration(V1);
    expect(JSON.stringify(diff)).not.toMatch(/6789/);
  });
});
