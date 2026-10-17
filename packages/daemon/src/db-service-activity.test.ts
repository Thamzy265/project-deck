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

async function setup() {
  const db = new FakeDbInspector({ app: [orders()] }, undefined, { writable: true });
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
