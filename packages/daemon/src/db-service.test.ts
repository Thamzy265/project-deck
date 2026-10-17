import type { AppSession, DbInspector, DeckEvents, RunningApp } from '@project-deck/core';
import {
  DB_UNTRUSTED_TEXT,
  DbError,
  DbSchemaResponse,
  EventBus,
  Registry,
} from '@project-deck/core';
import type { FakeTable } from '@project-deck/core/testing';
import { FakeAppSession, FakeDbInspector, fakeApp } from '@project-deck/core/testing';
import { registerDrift } from '@project-deck/db-drift';
import { FakeDriftApp } from '@project-deck/db-drift/testing';
import { FakeSqlGuard } from '@project-deck/sql-guard/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DbServiceOptions } from './db-service.js';
import { DbService, MAX_SNAPSHOTS } from './db-service.js';

const ordersTable = (): FakeTable => ({
  info: {
    name: 'orders',
    kind: 'table',
    sql: 'CREATE TABLE orders(id INTEGER PRIMARY KEY, item TEXT, status TEXT)',
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false, pk: true, pkPosition: 1, default: null },
      { name: 'item', type: 'TEXT', nullable: true, pk: false, default: null },
      { name: 'status', type: 'TEXT', nullable: true, pk: false, default: null },
    ],
    foreignKeys: [],
    indexes: [],
  },
  rows: [
    [1, 'Coffee', 'pending'],
    [2, 'Tea', 'pending'],
  ],
});

const services: DbService[] = [];

function serviceWith(
  inspector: DbInspector,
  over: Partial<DbServiceOptions> = {},
): { service: DbService; guard: FakeSqlGuard; bus: EventBus } {
  const registry = new Registry();
  registry.dbInspectors.register({ id: inspector.id, create: () => Promise.resolve(inspector) });
  const bus = new EventBus<DeckEvents>();
  const guard = new FakeSqlGuard();
  const service = new DbService({
    registry,
    bus,
    guard,
    settings: { allowWrites: false, hiddenColumns: [] },
    ...over,
  });
  services.push(service);
  return { service, guard, bus };
}

async function attached(
  inspector: DbInspector,
  over: Partial<DbServiceOptions> = {},
  app: RunningApp = fakeApp(),
) {
  const ctx = serviceWith(inspector, over);
  const session = new FakeAppSession(app);
  const detach = await ctx.service.attach(app, session);
  return { ...ctx, session, detach };
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()));
});

describe('DbService: listing and reading', () => {
  it('says no app is attached before an attach', async () => {
    const { service } = serviceWith(new FakeDbInspector({ app: [ordersTable()] }));
    await expect(service.list()).rejects.toMatchObject({ code: 'app-gone' });
  });

  it('lists databases from every backend with their source, and the writes setting', async () => {
    const { service } = await attached(new FakeDbInspector({ app: [ordersTable()] }), {
      settings: { allowWrites: true, hiddenColumns: [] },
    });
    expect(await service.list()).toEqual({
      databases: [{ name: 'app', backend: 'live', source: 'fake' }],
      sources: [{ id: 'fake', live: true, writable: false }],
      writesAllowed: true,
    });
  });

  it('reports a backend that cannot list (setup needed) and keeps the others', async () => {
    const registry = new Registry();
    registerDrift(registry);
    registry.dbInspectors.register({
      id: 'fake',
      create: () => Promise.resolve(new FakeDbInspector({ other: [ordersTable()] })),
    });
    const service = new DbService({
      registry,
      bus: new EventBus<DeckEvents>(),
      guard: new FakeSqlGuard(),
      settings: { allowWrites: false, hiddenColumns: [] },
    });
    services.push(service);
    const app = fakeApp();
    // A session with app extensions, but no flutterdeck_drift in the app.
    const drift = new FakeDriftApp();
    drift.extensions.remove('ext.flutterdeck.drift.v1.list');
    await service.attach(app, new FakeAppSession(app, { extensions: drift.extensions }));
    const list = await service.list();
    expect(list.databases).toEqual([{ name: 'other', backend: 'live', source: 'fake' }]);
    expect(list.sources.find((s) => s.id === 'drift')?.error?.code).toBe('setup-needed');
  });

  it('serves the schema and announces changed tables of live databases on the bus', async () => {
    const db = new FakeDbInspector({ app: [ordersTable()] });
    const { service, bus } = await attached(db);
    const seen = vi.fn();
    bus.on('db.changed', seen);
    expect((await service.schema('app', 'dashboard')).tables[0]?.name).toBe('orders');
    await db.insert('app', 'orders', [3, 'Cake', 'pending']);
    expect(seen).toHaveBeenCalledWith({ source: 'fake', db: 'app', table: 'orders' });
  });

  it('watches tables only for the dashboard, and stops when its last client goes (R9)', async () => {
    const db = new FakeDbInspector({ app: [ordersTable()] });
    const watch = vi.spyOn(db, 'watch');
    const { service, bus } = await attached(db);
    const seen = vi.fn();
    bus.on('db.changed', seen);
    await service.schema('app', 'claude');
    expect(watch).not.toHaveBeenCalled();
    await service.schema('app', 'dashboard');
    expect(watch).toHaveBeenCalledOnce();
    service.releaseWatches();
    await db.insert('app', 'orders', [3, 'Cake', 'pending']);
    expect(seen).not.toHaveBeenCalled();
    // A dashboard that comes back watches again.
    await service.schema('app', 'dashboard');
    expect(watch).toHaveBeenCalledTimes(2);
  });

  it("leaves the app's CREATE text out for Claude and says the rest is untrusted app text", async () => {
    const { service } = await attached(new FakeDbInspector({ app: [ordersTable()] }));
    const claude = await service.schema('app', 'claude');
    expect(claude.tables[0]).not.toHaveProperty('sql');
    expect(claude.tables[0]?.columns[0]?.name).toBe('id');
    expect(claude.untrusted).toBe(DB_UNTRUSTED_TEXT);
    const dashboard = await service.schema('app', 'dashboard');
    expect(dashboard.tables[0]?.sql).toMatch(/^CREATE TABLE orders/);
    expect(dashboard).not.toHaveProperty('untrusted');
    expect(DbSchemaResponse.parse(claude)).toEqual(claude);
  });

  it('answers not-found for an unknown database', async () => {
    const { service } = await attached(new FakeDbInspector({ app: [ordersTable()] }));
    await expect(service.schema('nope', 'dashboard')).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('DbService: the read-only gate (ADR 0005)', () => {
  it('checks every query with the schema SQL before it reaches the backend', async () => {
    const db = new FakeDbInspector({ app: [ordersTable()] });
    const query = vi.spyOn(db, 'query');
    const { service, guard } = await attached(db);
    guard.refuse('DELETE FROM orders', 'writes-data', 'it deletes rows');
    await expect(
      service.query({ db: 'app', sql: 'DELETE FROM orders' }, 'dashboard'),
    ).rejects.toMatchObject({
      code: 'refused',
      message: 'it deletes rows',
    });
    expect(query).not.toHaveBeenCalled();
    expect(guard.calls[0]?.opts).toEqual({
      schemaSql: ['CREATE TABLE orders(id INTEGER PRIMARY KEY, item TEXT, status TEXT)'],
      mode: 'read',
    });
    expect(
      (await service.query({ db: 'app', sql: 'SELECT * FROM orders' }, 'dashboard')).rows,
    ).toHaveLength(2);
  });

  it('applies hidden columns to Claude (token callers), not to the dashboard', async () => {
    const db = new FakeDbInspector({ app: [ordersTable()] }, () => ({
      columns: ['id', 'status'],
      rows: [[1, 'pending']],
    }));
    const { service, guard } = await attached(db, {
      settings: { allowWrites: false, hiddenColumns: ['orders.item'] },
    });
    await service.query({ db: 'app', sql: 'SELECT id, status FROM orders' }, 'claude');
    expect(guard.calls[0]?.opts.hiddenColumns).toEqual([{ table: 'orders', column: 'item' }]);
    const before = guard.calls.length;
    await service.query({ db: 'app', sql: 'SELECT id, status FROM orders' }, 'dashboard');
    expect(guard.calls.slice(before).map((c) => c.opts.hiddenColumns)).toEqual([undefined]);
  });

  it('fails closed when the gate cannot answer', async () => {
    const db = new FakeDbInspector({ app: [ordersTable()] });
    const query = vi.spyOn(db, 'query');
    const { service } = await attached(db, {
      guard: new FakeSqlGuard(() => ({
        ok: false,
        code: 'timeout',
        reason: "Couldn't check the query",
      })),
    });
    await expect(service.query({ db: 'app', sql: 'SELECT 1' }, 'claude')).rejects.toMatchObject({
      code: 'refused',
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('fails closed when the schema SQL is cut, without asking the gate', async () => {
    const db = new FakeDbInspector({ app: [ordersTable()] });
    vi.spyOn(db, 'schemaSql').mockRejectedValue(new DbError('too-large', 'Schema cut'));
    const { service, guard } = await attached(db);
    await expect(service.query({ db: 'app', sql: 'SELECT 1' }, 'dashboard')).rejects.toMatchObject({
      code: 'too-large',
    });
    expect(guard.calls).toHaveLength(0);
  });

  it('reads the schema again after a hot restart, and once when the gate finds a new table', async () => {
    const db = new FakeDbInspector({ app: [ordersTable()] });
    const schemaSql = vi.spyOn(db, 'schemaSql');
    const { service, guard, bus } = await attached(db);
    await service.query({ db: 'app', sql: 'SELECT * FROM orders' }, 'dashboard');
    await service.query({ db: 'app', sql: 'SELECT * FROM orders' }, 'dashboard');
    expect(schemaSql).toHaveBeenCalledTimes(1);
    bus.emit('app.reloaded', { appId: 'app-1', result: { ok: true, kind: 'hot-restart' } });
    await service.query({ db: 'app', sql: 'SELECT * FROM orders' }, 'dashboard');
    expect(schemaSql).toHaveBeenCalledTimes(2);
    let first = true;
    const refuseOnce = new FakeSqlGuard(() => {
      if (!first) return { ok: true, kind: 'select', tables: [], functions: [], recursive: false };
      first = false;
      return { ok: false, code: 'invalid-sql', reason: 'no such table: lines' };
    });
    Object.assign(guard, { check: refuseOnce.check.bind(refuseOnce) });
    await service.query({ db: 'app', sql: 'SELECT * FROM orders' }, 'dashboard');
    expect(schemaSql).toHaveBeenCalledTimes(3);
  });

  it("hides backend error text that isn't a DbError (it can quote SQL or rows)", async () => {
    const db = new FakeDbInspector({ app: [ordersTable()] });
    const { service } = await attached(db);
    const err: unknown = await service
      .query({ db: 'app', sql: 'SELECT secret_value FROM orders' }, 'dashboard')
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'internal' });
    expect((err as Error).message).not.toContain('secret_value');
  });
});

describe('DbService: snapshots and diff (design note D5)', () => {
  it('names added, changed and removed rows, with new values only', async () => {
    const tables = { app: [ordersTable()] };
    const db = new FakeDbInspector(tables);
    const { service } = await attached(db);
    const snap = await service.snapshot({ db: 'app', label: 'before' });
    expect(snap).toMatchObject({ db: 'app', label: 'before' });
    await db.update('app', 'orders', 0, [1, 'Coffee', 'shipped']);
    await db.insert('app', 'orders', [3, 'Cake', 'pending']);
    tables.app[0]?.rows.splice(1, 1);
    const diff = await service.diff({ db: 'app' }, 'dashboard');
    expect(diff).toMatchObject({
      db: 'app',
      snapshotId: snap.id,
      takenAt: snap.takenAt,
      truncated: false,
      tablesOmitted: 0,
    });
    expect(diff.tables).toEqual([
      {
        table: 'orders',
        columns: ['id', 'item', 'status'],
        key: ['id'],
        matchedByRowid: false,
        added: [{ key: 3, row: [3, 'Cake', 'pending'] }],
        changed: [{ key: 1, row: [1, 'Coffee', 'shipped'], columns: ['status'] }],
        removed: [{ key: 2 }],
        counts: { added: 1, changed: 1, removed: 1 },
        truncated: false,
      },
    ]);
  });

  it('answers no tables when nothing changed, and needs a snapshot first', async () => {
    const { service } = await attached(new FakeDbInspector({ app: [ordersTable()] }));
    await expect(service.diff({ db: 'app' }, 'dashboard')).rejects.toMatchObject({
      code: 'not-found',
    });
    await service.snapshot({ db: 'app' });
    expect((await service.diff({ db: 'app' }, 'dashboard')).tables).toEqual([]);
  });

  it('caps rows per table for Claude at 50 and says the real counts', async () => {
    const db = new FakeDbInspector({ app: [ordersTable()] });
    const { service } = await attached(db);
    await service.snapshot({ db: 'app' });
    for (let i = 10; i < 80; i++) await db.insert('app', 'orders', [i, `item ${i}`, 'pending']);
    const claude = await service.diff({ db: 'app' }, 'claude');
    expect(claude.tables[0]?.added).toHaveLength(50);
    expect(claude.tables[0]).toMatchObject({ counts: { added: 70 }, truncated: true });
    const dashboard = await service.diff({ db: 'app' }, 'dashboard');
    expect(dashboard.tables[0]?.added).toHaveLength(70);
  });

  it('drops hidden columns from what Claude sees, and changes only they had', async () => {
    const db = new FakeDbInspector({ app: [ordersTable()] });
    const { service } = await attached(db, {
      settings: { allowWrites: false, hiddenColumns: ['orders.item'] },
    });
    await service.snapshot({ db: 'app' });
    await db.update('app', 'orders', 0, [1, 'Espresso', 'pending']);
    await db.update('app', 'orders', 1, [2, 'Green tea', 'shipped']);
    const claude = await service.diff({ db: 'app' }, 'claude');
    expect(claude.tables[0]).toMatchObject({
      columns: ['id', 'status'],
      changed: [{ key: 2, row: [2, 'shipped'], columns: ['status'] }],
      counts: { changed: 1 },
    });
    const dashboard = await service.diff({ db: 'app' }, 'dashboard');
    expect(dashboard.tables[0]?.changed).toHaveLength(2);
  });

  it('keeps at most 20 snapshots and drops them all when the app changes', async () => {
    const { service, detach } = await attached(new FakeDbInspector({ app: [ordersTable()] }));
    const first = await service.snapshot({ db: 'app' });
    for (let i = 0; i < MAX_SNAPSHOTS; i++) await service.snapshot({ db: 'app' });
    await expect(
      service.diff({ db: 'app', snapshotId: first.id }, 'dashboard'),
    ).rejects.toMatchObject({
      code: 'not-found',
    });
    const last = await service.snapshot({ db: 'app' });
    await detach();
    await expect(
      service.diff({ db: 'app', snapshotId: last.id }, 'dashboard'),
    ).rejects.toMatchObject({
      code: 'app-gone',
    });
  });

  it('reports a table too large to diff', async () => {
    const db = new FakeDbInspector({ app: [ordersTable()] });
    const { service } = await attached(db);
    const big = {
      name: 'events',
      error: {
        code: 'too-large',
        message: 'Too large to compare: more than 10,000 rows in events',
      },
    };
    vi.spyOn(db, 'rowHashes').mockResolvedValue({ takenAt: 1, tables: [big] });
    await service.snapshot({ db: 'app' });
    expect((await service.diff({ db: 'app' }, 'dashboard')).tables).toEqual([
      expect.objectContaining({ table: 'events', tooLarge: true, error: big.error }),
    ]);
  });
});

describe('DbService: edits (design review S1)', () => {
  const writable = () =>
    new FakeDbInspector({ app: [ordersTable()] }, undefined, { writable: true });
  const edit = {
    db: 'app',
    sql: 'UPDATE orders SET status = ? WHERE id = ?',
    params: ['shipped', 1],
  };
  const allow = { settings: { allowWrites: true, hiddenColumns: [] } };

  it('refuses edits while writes are off, and on read-only backends', async () => {
    const off = await attached(writable());
    await expect(off.service.requestEdit(edit)).rejects.toMatchObject({ code: 'not-allowed' });
    const readOnly = await attached(new FakeDbInspector({ app: [ordersTable()] }), allow);
    await expect(readOnly.service.requestEdit(edit)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('checks the edit in write mode, binds it to a request id, and runs it once with a fresh token', async () => {
    const db = writable();
    const { service, guard } = await attached(db, allow);
    guard.answer(edit.sql, {
      ok: true,
      kind: 'write',
      tables: ['orders'],
      functions: [],
      recursive: false,
    });
    const request = await service.requestEdit(edit);
    expect(guard.calls.at(-1)?.opts.mode).toBe('write');
    expect(request).toMatchObject({
      db: 'app',
      sql: edit.sql,
      params: edit.params,
      tables: ['orders'],
    });
    expect(request.requestId).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(db.executed).toHaveLength(0);
    expect(
      await service.confirmEdit({
        requestId: request.requestId,
        sql: edit.sql,
        params: edit.params,
      }),
    ).toEqual({
      changes: 1,
    });
    expect(db.executed).toHaveLength(1);
    expect(db.executed[0]?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Single use.
    await expect(
      service.confirmEdit({ requestId: request.requestId, sql: edit.sql, params: edit.params }),
    ).rejects.toMatchObject({ code: 'bad-token' });
    const again = await service.requestEdit(edit);
    await service.confirmEdit({ requestId: again.requestId, sql: edit.sql, params: edit.params });
    expect(db.executed[1]?.token).not.toBe(db.executed[0]?.token);
  });

  it('refuses a confirm whose SQL or parameters differ from the request', async () => {
    const db = writable();
    const { service } = await attached(db, allow);
    const a = await service.requestEdit(edit);
    await expect(
      service.confirmEdit({ requestId: a.requestId, sql: 'DELETE FROM orders', params: [] }),
    ).rejects.toMatchObject({ code: 'bad-token' });
    const b = await service.requestEdit(edit);
    await expect(
      service.confirmEdit({ requestId: b.requestId, sql: edit.sql, params: ['shipped', 2] }),
    ).rejects.toMatchObject({ code: 'bad-token' });
    expect(db.executed).toHaveLength(0);
  });

  it('refuses a confirm after 60 s, after a hot restart, or after cancel', async () => {
    let now = 1_000_000;
    const db = writable();
    const { service, bus } = await attached(db, { ...allow, now: () => now });
    const late = await service.requestEdit(edit);
    now += 60_001;
    await expect(
      service.confirmEdit({ requestId: late.requestId, sql: edit.sql, params: edit.params }),
    ).rejects.toMatchObject({ code: 'timeout', message: 'Not run: no answer in 60 s.' });
    const restarted = await service.requestEdit(edit);
    bus.emit('app.reloaded', { appId: 'app-1', result: { ok: true, kind: 'hot-restart' } });
    await expect(
      service.confirmEdit({ requestId: restarted.requestId, sql: edit.sql, params: edit.params }),
    ).rejects.toMatchObject({ code: 'bad-token' });
    const cancelled = await service.requestEdit(edit);
    service.cancelEdit(cancelled.requestId);
    await expect(
      service.confirmEdit({ requestId: cancelled.requestId, sql: edit.sql, params: edit.params }),
    ).rejects.toMatchObject({ code: 'bad-token' });
    expect(db.executed).toHaveLength(0);
  });

  it('refuses an edit the gate refuses in write mode', async () => {
    const { service, guard } = await attached(writable(), allow);
    guard.refuse(edit.sql, 'multiple-tables', 'it changes more than one table');
    await expect(service.requestEdit(edit)).rejects.toMatchObject({ code: 'refused' });
  });
});

describe('DbService: live Drift app', () => {
  it('serves the recorded drift app end to end', async () => {
    const registry = new Registry();
    registerDrift(registry);
    const service = new DbService({
      registry,
      bus: new EventBus<DeckEvents>(),
      guard: new FakeSqlGuard(),
      settings: { allowWrites: false, hiddenColumns: [] },
    });
    services.push(service);
    const app = fakeApp();
    const drift = new FakeDriftApp();
    const session: AppSession = new FakeAppSession(app, { extensions: drift.extensions });
    await service.attach(app, session);
    expect((await service.list()).databases).toEqual([
      { name: 'app', backend: 'live', source: 'drift' },
    ]);
    expect((await service.query({ db: 'app', sql: 'SELECT 1' }, 'claude')).rows).toHaveLength(2);
  });

  it('passes the row check of an edit to the app unchanged, and its 0 changes back (review L3)', async () => {
    const registry = new Registry();
    registerDrift(registry);
    const guard = new FakeSqlGuard();
    const service = new DbService({
      registry,
      bus: new EventBus<DeckEvents>(),
      guard,
      settings: { allowWrites: true, hiddenColumns: [] },
    });
    services.push(service);
    const app = fakeApp();
    const drift = new FakeDriftApp();
    await service.attach(app, new FakeAppSession(app, { extensions: drift.extensions }));
    // As row details builds it: the key, then each edited column as it was read.
    const edit = {
      db: 'app',
      sql: 'UPDATE "orders" SET "status" = ? WHERE "id" IS ? AND "status" IS ? AND "note" IS ?',
      params: ['shipped', { type: 'int' as const, value: '9007199254740993' }, 'pending', null],
    };
    guard.answer(edit.sql, {
      ok: true,
      kind: 'write',
      tables: ['orders'],
      functions: [],
      recursive: false,
    });
    // The app's row was replaced, so its own UPDATE matched nothing.
    drift.handle('execute', (p) => {
      drift.executed.push({ db: p.db ?? '', sql: p.sql ?? '', params: p.params });
      return { changes: 0 };
    });
    const request = await service.requestEdit(edit);
    expect(
      await service.confirmEdit({
        requestId: request.requestId,
        sql: edit.sql,
        params: edit.params,
      }),
    ).toEqual({ changes: 0 });
    expect(drift.executed).toEqual([
      { db: 'app', sql: edit.sql, params: JSON.stringify(edit.params) },
    ]);
  });
});

describe('DbService: edit expiry boundary', () => {
  it('refuses a confirm at exactly expiresAt', async () => {
    let now = 5_000_000;
    const db = new FakeDbInspector({ app: [ordersTable()] }, undefined, { writable: true });
    const { service } = await attached(db, {
      settings: { allowWrites: true, hiddenColumns: [] },
      now: () => now,
    });
    const sql = 'DELETE FROM orders WHERE id = 1';
    const request = await service.requestEdit({ db: 'app', sql });
    now = request.expiresAt;
    await expect(service.confirmEdit({ requestId: request.requestId, sql })).rejects.toMatchObject({
      code: 'timeout',
    });
    expect(db.executed).toHaveLength(0);
  });
});

describe('DbService.list (R10)', () => {
  it('asks every backend at once, so a slow one does not hold up the others', async () => {
    const slow = new FakeDbInspector({ a: [ordersTable()] }, undefined, { id: 'slow' });
    const quick = new FakeDbInspector({ b: [ordersTable()] }, undefined, { id: 'quick' });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slowList = slow.listDatabases.bind(slow);
    vi.spyOn(slow, 'listDatabases').mockImplementation(async () => {
      await gate;
      return slowList();
    });
    const quickList = vi.spyOn(quick, 'listDatabases');
    const registry = new Registry();
    registry.dbInspectors.register({ id: 'slow', create: () => Promise.resolve(slow) });
    registry.dbInspectors.register({ id: 'quick', create: () => Promise.resolve(quick) });
    const service = new DbService({
      registry,
      bus: new EventBus<DeckEvents>(),
      guard: new FakeSqlGuard(),
      settings: { allowWrites: false, hiddenColumns: [] },
    });
    services.push(service);
    const app = fakeApp();
    await service.attach(app, new FakeAppSession(app));
    const listing = service.list();
    await new Promise((r) => setTimeout(r, 10));
    expect(quickList).toHaveBeenCalled();
    release();
    expect((await listing).databases.map((d) => d.name)).toEqual(['a', 'b']);
  });
});

describe('DbService.query result checks (R8)', () => {
  it('refuses Claude a result whose columns are named like a hidden column', async () => {
    const db = new FakeDbInspector({ app: [ordersTable()] }, () => ({
      columns: ['id', 'item'],
      rows: [[1, 'Coffee']],
    }));
    const { service } = await attached(db, {
      settings: { allowWrites: false, hiddenColumns: ['orders.item'] },
    });
    await expect(
      service.query({ db: 'app', sql: 'SELECT id, item FROM orders' }, 'claude'),
    ).rejects.toMatchObject({ code: 'refused' });
    // The dashboard sees hidden columns by design.
    expect(
      (await service.query({ db: 'app', sql: 'SELECT id, item FROM orders' }, 'dashboard')).rows,
    ).toHaveLength(1);
  });

  it('runs the query on the schema the gate checked (the snapshot copy is pinned)', async () => {
    const db = new FakeDbInspector({ app: [ordersTable()] });
    const query = vi.spyOn(db, 'query');
    const { service } = await attached(db);
    await service.query({ db: 'app', sql: 'SELECT * FROM orders' }, 'dashboard');
    expect(query.mock.calls[0]?.[3]).toMatchObject({
      checkedSchemaSql: ['CREATE TABLE orders(id INTEGER PRIMARY KEY, item TEXT, status TEXT)'],
    });
  });
});
