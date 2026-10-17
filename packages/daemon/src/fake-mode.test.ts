import type { DeckEvents } from '@project-deck/core';
import { EventBus, Registry } from '@project-deck/core';
import { fakeApp } from '@project-deck/core/testing';
import { FakeSqlGuard } from '@project-deck/sql-guard/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { DbService } from './db-service.js';
import { registerFake } from './fake-mode.js';

let service: DbService | undefined;
afterEach(async () => {
  await service?.close();
});

describe('--fake databases', { timeout: 20_000 }, () => {
  it('serves a live fake database and fake Android snapshot files', async () => {
    const registry = new Registry();
    registerFake(registry);
    service = new DbService({
      registry,
      bus: new EventBus<DeckEvents>(),
      guard: new FakeSqlGuard(),
      settings: { allowWrites: false, hiddenColumns: [] },
    });
    const app = fakeApp();
    const connector = registry.connectors.require('fake');
    await service.attach(app, await connector.attach(app.id));
    const list = await service.list();
    expect(list.databases).toEqual([
      { name: 'app', backend: 'live', source: 'fake' },
      { name: 'app_flutter/app.sqlite', backend: 'snapshot', source: 'sqlite-file' },
      { name: 'databases/legacy.db', backend: 'snapshot', source: 'sqlite-file' },
    ]);
    const snapshot = await service.query(
      { db: 'app_flutter/app.sqlite', sql: 'SELECT count(*) FROM orders' },
      'dashboard',
    );
    expect(snapshot.rows).toEqual([[3]]);
  });

  it('runs real SQL on the live fake database, with keys and a trigger', async () => {
    const registry = new Registry();
    registerFake(registry);
    service = new DbService({
      registry,
      bus: new EventBus<DeckEvents>(),
      guard: new FakeSqlGuard(),
      settings: { allowWrites: true, hiddenColumns: [] },
    });
    const app = fakeApp();
    const connector = registry.connectors.require('fake');
    await service.attach(app, await connector.attach(app.id));
    const page = await service.query(
      { db: 'app', sql: 'SELECT id, item FROM orders ORDER BY id DESC LIMIT ?', params: [1] },
      'dashboard',
    );
    expect(page.rows).toEqual([[2, 'Tea']]);
    const { tables } = await service.schema('app', 'dashboard');
    expect(tables.map((t) => t.name)).toEqual(['audit_log', 'customers', 'orders']);
    expect(tables.find((t) => t.name === 'orders')?.foreignKeys).toEqual([
      { from: 'customer_id', table: 'customers', to: 'id' },
    ]);
    const triggers = await service.query(
      { db: 'app', sql: "SELECT name FROM sqlite_schema WHERE type = 'trigger'" },
      'dashboard',
    );
    expect(triggers.rows).toEqual([['customers_audit']]);
  });
});
