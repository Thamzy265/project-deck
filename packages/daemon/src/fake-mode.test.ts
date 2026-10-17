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
});
