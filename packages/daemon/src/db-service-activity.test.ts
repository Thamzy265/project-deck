import type { DeckEvents } from '@project-deck/core';
import { EventBus, Registry } from '@project-deck/core';
import type { FakeTable } from '@project-deck/core/testing';
import { FakeAppSession, FakeDbInspector, fakeApp } from '@project-deck/core/testing';
import type { GuardResult } from '@project-deck/sql-guard';
import { FakeSqlGuard } from '@project-deck/sql-guard/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { DbService } from './db-service.js';

const orders = (): FakeTable => ({
  info: {
    name: 'orders',
    kind: 'table',
    sql: 'CREATE TABLE orders(id INTEGER PRIMARY KEY, status TEXT)',
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false, pk: true, pkPosition: 1, default: null },
      { name: 'status', type: 'TEXT', nullable: true, pk: false, default: null },
    ],
    foreignKeys: [],
    indexes: [],
  },
  rows: [[1, 'pending']],
});

const services: DbService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()));
});

async function setup(changes = 1) {
  const db = new FakeDbInspector({ app: [orders()] }, undefined, { writable: true, changes });
  const registry = new Registry();
  registry.dbInspectors.register({ id: db.id, create: () => Promise.resolve(db) });
  const bus = new EventBus<DeckEvents>();
  const guard = new FakeSqlGuard();
  const service = new DbService({
    registry,
    bus,
    guard,
    settings: { allowWrites: true, hiddenColumns: [] },
  });
  services.push(service);
  const app = fakeApp();
  await service.attach(app, new FakeAppSession(app));
  const events: [keyof DeckEvents, unknown][] = [];
  bus.onAny((event, payload) => {
    if (event.startsWith('db.') && event !== 'db.changed') events.push([event, payload]);
  });
  return { service, guard, events };
}

const sql = 'UPDATE orders SET status = ? WHERE id = ?';
const write: GuardResult = {
  ok: true,
  kind: 'write',
  tables: ['orders'],
  written: ['orders'],
  functions: [],
  recursive: false,
};

describe('DbService: Activity events (design note, Observability)', () => {
  it('announces a snapshot and a diff by database name only', async () => {
    const { service, events } = await setup();
    await service.snapshot({ db: 'app' });
    await service.diff({ db: 'app' }, 'dashboard');
    expect(events).toEqual([
      ['db.snapshot', { db: 'app' }],
      ['db.diff', { db: 'app' }],
    ]);
  });

  it('announces nothing for a diff that failed', async () => {
    const { service, events } = await setup();
    await expect(service.diff({ db: 'app' }, 'dashboard')).rejects.toMatchObject({
      code: 'not-found',
    });
    expect(events).toEqual([]);
  });

  it('announces an allowed edit with its tables and change count, never its SQL', async () => {
    const { service, guard, events } = await setup();
    guard.answer(sql, write);
    const request = await service.requestEdit({ db: 'app', sql, params: ['shipped', 1] });
    await service.confirmEdit({ requestId: request.requestId, sql, params: ['shipped', 1] });
    expect(events).toEqual([
      ['db.write', { db: 'app', tables: ['orders'], allowed: true, changes: 1 }],
    ]);
  });

  it('names only the table an edit writes, not tables it reads for foreign keys (review note)', async () => {
    const { service, guard, events } = await setup();
    const fk = 'UPDATE "orders" SET "customer_id" = ? WHERE "id" IS ?';
    // The gate lists the written table first (Q2), then what the statement reads.
    guard.answer(fk, { ...write, tables: ['orders', 'customers'] });
    const request = await service.requestEdit({ db: 'app', sql: fk, params: [2, 1] });
    expect(request.tables).toEqual(['orders']);
    await service.confirmEdit({ requestId: request.requestId, sql: fk, params: [2, 1] });
    const cancelled = await service.requestEdit({ db: 'app', sql: fk, params: [2, 1] });
    service.cancelEdit(cancelled.requestId);
    expect(events).toEqual([
      ['db.write', { db: 'app', tables: ['orders'], allowed: true, changes: 1 }],
      ['db.write', { db: 'app', tables: ['orders'], allowed: false }],
    ]);
  });

  it('logs a checked edit that matched no row as denied: the row changed (review note)', async () => {
    const { service, guard, events } = await setup(0);
    const update = 'UPDATE "orders" SET "status" = ? WHERE "id" IS ? AND "status" IS ?';
    const remove = 'DELETE FROM "orders" WHERE "id" IS ? AND "status" IS ?';
    for (const [edit, params] of [
      [update, ['shipped', 1, 'pending']],
      [remove, [1, 'pending']],
    ] as const) {
      guard.answer(edit, write);
      const request = await service.requestEdit({ db: 'app', sql: edit, params: [...params] });
      expect(
        await service.confirmEdit({ requestId: request.requestId, sql: edit, params: [...params] }),
      ).toEqual({ changes: 0 });
    }
    expect(events).toEqual([
      ['db.write', { db: 'app', tables: ['orders'], allowed: false, reason: 'row-changed' }],
      ['db.write', { db: 'app', tables: ['orders'], allowed: false, reason: 'row-changed' }],
    ]);
  });

  it('announces an edit the gate refuses as denied, naming its table (lead decision G4)', async () => {
    const { service, guard, events } = await setup();
    const refused = 'UPDATE "orders" SET "status" = ? WHERE "id" IS ?';
    guard.refuse(refused, 'multiple-tables', 'An edit may change one table only.');
    await expect(
      service.requestEdit({ db: 'app', sql: refused, params: ['x', 1] }),
    ).rejects.toMatchObject({ code: 'refused' });
    guard.refuse('DELETE FROM odd', 'multiple-tables', 'x');
    await expect(service.requestEdit({ db: 'app', sql: 'DELETE FROM odd' })).rejects.toMatchObject({
      code: 'refused',
    });
    expect(events).toEqual([
      ['db.write', { db: 'app', tables: ['orders'], allowed: false }],
      ['db.write', { db: 'app', tables: ['odd'], allowed: false }],
    ]);
  });

  it('announces an edit refused for not naming one written table as denied (review R5)', async () => {
    const cases: (string[] | undefined)[] = [undefined, [], ['orders', 'audit_log']];
    for (const written of cases) {
      const { service, guard, events } = await setup();
      const base = { ok: true as const, kind: 'write' as const, functions: [], recursive: false };
      guard.answer(sql, {
        ...base,
        tables: ['orders'],
        ...(written === undefined ? {} : { written }),
      });
      await expect(service.requestEdit({ db: 'app', sql, params: ['x', 1] })).rejects.toMatchObject(
        {
          code: 'refused',
        },
      );
      expect(events, JSON.stringify(written)).toEqual([
        ['db.write', { db: 'app', tables: ['orders'], allowed: false }],
      ]);
    }
  });

  it('announces a cancelled edit as denied, once, and an unknown id not at all', async () => {
    const { service, guard, events } = await setup();
    guard.answer(sql, write);
    const request = await service.requestEdit({ db: 'app', sql, params: ['shipped', 1] });
    service.cancelEdit(request.requestId);
    service.cancelEdit(request.requestId);
    service.cancelEdit('x'.repeat(32));
    expect(events).toEqual([['db.write', { db: 'app', tables: ['orders'], allowed: false }]]);
  });
});
