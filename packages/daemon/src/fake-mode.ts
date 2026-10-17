import type { Registry } from '@project-deck/core';
import { FakeAppConnector, fakeApp } from '@project-deck/core/testing';
import { FakeLiveDatabase, fakeSnapshotFactory } from '@project-deck/db-sqlite/testing';

/** The fake app stops adding orders here (lead, batch 4 QA: 50 ran out after 4 min). */
export const MAX_FAKE_ORDERS = 500;

/**
 * The fake app's database: customers, orders that point at them, and an audit table
 * that a trigger on customers writes, so the dashboard can show its "triggers count as
 * a second table" refusal (QA G2).
 */
export const FAKE_DB_SETUP: readonly string[] = [
  'CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT)',
  "CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created INTEGER NOT NULL, customer_id INTEGER REFERENCES customers(id))",
  'CREATE TABLE audit_log (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, note TEXT NOT NULL)',
  "CREATE TRIGGER customers_audit AFTER UPDATE ON customers BEGIN INSERT INTO audit_log (at, note) VALUES (unixepoch(), 'customer changed'); END",
  "INSERT INTO customers VALUES (1, 'Ada Lovelace', 'ada@example.com'), (2, 'Grace Hopper', NULL)",
  "INSERT INTO orders VALUES (1, 'Coffee', 'pending', 1760000000000, 1), (2, 'Tea', 'shipped', 1760000001000, 2)",
];

/**
 * `--fake`: an in-memory app with a live database (real SQL in memory; writes allowed
 * by the backend, still subject to db.allowWrites and the confirm) that gains an order
 * every 5 s, and a fake Android device whose database files the snapshot backend reads
 * with the real engine. Lets the API and dashboard be exercised without Flutter or a
 * device. Each attach starts the database afresh.
 */
export function registerFake(registry: Registry): void {
  const connector = new FakeAppConnector('fake', [fakeApp()]);
  registry.connectors.register(connector);
  let live: FakeLiveDatabase | undefined;
  registry.dbInspectors.register({
    id: 'fake',
    create: async () => {
      live = await FakeLiveDatabase.create('app', FAKE_DB_SETUP);
      return live;
    },
  });
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
    if (next > MAX_FAKE_ORDERS || live === undefined) return;
    live
      .run('INSERT INTO orders (item, status, created, customer_id) VALUES (?, ?, ?, ?)', [
        `Order ${next}`,
        'pending',
        Date.now(),
        (next % 2) + 1,
      ])
      .catch(() => undefined);
    next++;
  }, 5000).unref();
}
