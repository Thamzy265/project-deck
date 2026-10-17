import type { Registry } from '@project-deck/core';
import type { FakeTable } from '@project-deck/core/testing';
import { FakeAppConnector, FakeDbInspector, fakeApp } from '@project-deck/core/testing';
import { fakeSnapshotFactory } from '@project-deck/db-sqlite/testing';

const MAX_FAKE_ORDERS = 50;

function ordersTable(): FakeTable {
  return {
    info: {
      name: 'orders',
      kind: 'table',
      sql: "CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created INTEGER NOT NULL)",
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, pk: true, pkPosition: 1, default: null },
        { name: 'item', type: 'TEXT', nullable: false, pk: false, default: null },
        { name: 'status', type: 'TEXT', nullable: false, pk: false, default: "'pending'" },
        { name: 'created', type: 'INTEGER', nullable: false, pk: false, default: null },
      ],
      foreignKeys: [],
      indexes: [],
    },
    rows: [
      [1, 'Coffee', 'pending', 1_760_000_000_000],
      [2, 'Tea', 'shipped', 1_760_000_001_000],
    ],
  };
}

/**
 * `--fake`: an in-memory app with a live database (writes allowed by the backend, still
 * subject to db.allowWrites and the confirm) that gains an order every 5 s, and a fake
 * Android device whose database files the snapshot backend reads with the real engine.
 * Lets the API and dashboard be exercised without Flutter or a device.
 */
export function registerFake(registry: Registry): void {
  const connector = new FakeAppConnector('fake', [fakeApp()]);
  registry.connectors.register(connector);
  const db = new FakeDbInspector({ app: [ordersTable()] }, undefined, { writable: true });
  registry.dbInspectors.register({ id: db.id, create: () => Promise.resolve(db) });
  registry.dbInspectors.register(fakeSnapshotFactory());
  let next = 3;
  setInterval(() => {
    connector.sessions.get('app-1')?.logs().push({
      ts: Date.now(),
      level: 'info',
      source: 'app',
      message: 'Heartbeat from the fake app',
    });
  }, 2000).unref();
  setInterval(() => {
    if (next > MAX_FAKE_ORDERS) return;
    void db.insert('app', 'orders', [next, `Order ${next}`, 'pending', Date.now()]);
    next++;
  }, 5000).unref();
}
