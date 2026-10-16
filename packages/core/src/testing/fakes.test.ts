import { describe, expect, it, vi } from 'vitest';
import { FakeAppConnector, FakeDbInspector, FakeTaskProvider, fakeApp, fakeTask } from './index.js';

describe('FakeAppConnector', () => {
  it('reports app changes and ends sessions of removed apps', async () => {
    const connector = new FakeAppConnector('fake', [fakeApp()]);
    await connector.start();
    const changes = vi.fn();
    connector.onAppsChanged(changes);

    connector.addApp(fakeApp({ id: 'app-2' }));
    expect(changes).toHaveBeenLastCalledWith([fakeApp(), fakeApp({ id: 'app-2' })]);

    const session = await connector.attach('app-1');
    const exit = vi.fn();
    session.on('exit', exit);
    connector.removeApp('app-1');
    expect(exit).toHaveBeenCalledOnce();
    expect(await connector.listApps()).toEqual([fakeApp({ id: 'app-2' })]);
  });

  it('rejects attaching to an unknown app', async () => {
    await expect(new FakeAppConnector().attach('nope')).rejects.toThrow(/No running app/);
  });

  it('stop detaches sessions', async () => {
    const connector = new FakeAppConnector('fake', [fakeApp()]);
    const session = await connector.attach('app-1');
    await connector.stop();
    expect(session.detached).toBe(true);
  });
});

describe('FakeAppSession', () => {
  it('replays queued reload results then falls back to success', async () => {
    const connector = new FakeAppConnector('fake', [fakeApp()]);
    const session = await connector.attach('app-1');
    const reloaded = vi.fn();
    session.on('reloaded', reloaded);
    session.nextReload({ ok: false, reason: 'compile-error', message: 'lib/main.dart:3' });

    expect((await session.reload()).ok).toBe(false);
    expect((await session.reload()).ok).toBe(true);
    expect(reloaded).toHaveBeenCalledTimes(2);
  });

  it('returns not-attached after detach', async () => {
    const session = await new FakeAppConnector('fake', [fakeApp()]).attach('app-1');
    await session.detach();
    expect(await session.restart()).toMatchObject({ ok: false, reason: 'not-attached' });
  });

  it('simulates a reload made by someone else', async () => {
    const session = await new FakeAppConnector('fake', [fakeApp()]).attach('app-1');
    const reloaded = vi.fn();
    session.on('reloaded', reloaded);
    session.simulateExternalReload();
    session.simulateExternalReload({ ok: false, reason: 'compile-error', message: 'oops' });
    expect(reloaded.mock.calls).toEqual([
      [{ ok: true, kind: 'hot-reload', source: 'external' }],
      [{ ok: false, reason: 'compile-error', message: 'oops', source: 'external' }],
    ]);
    expect(session.reloadCount).toBe(0);
  });
});

describe('FakeDbInspector', () => {
  const ordersTable = () => ({
    info: {
      name: 'orders',
      kind: 'table' as const,
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, pk: true, pkPosition: 1, default: null },
        { name: 'status', type: 'TEXT', nullable: false, pk: false, default: null },
      ],
      foreignKeys: [],
      indexes: [],
    },
    rows: [
      [1, 'pending'],
      [2, 'shipped'],
    ],
  });

  it('serves schema with row counts and SELECT * with truncation', async () => {
    const db = new FakeDbInspector({ app: [ordersTable()] });
    expect(await db.listDatabases()).toEqual([{ name: 'app', backend: 'live' }]);
    expect((await db.schema('app'))[0]?.rowCount).toBe(2);
    expect(await db.query('app', 'SELECT * FROM orders', [], { limit: 1 })).toMatchObject({
      columns: ['id', 'status'],
      rows: [[1, 'pending']],
      truncated: true,
    });
  });

  it('serves the whole schema as sqlite_schema SQL, indexes and triggers included', async () => {
    const orders = {
      ...ordersTable(),
      info: {
        ...ordersTable().info,
        sql: 'CREATE TABLE orders(id INTEGER PRIMARY KEY, status TEXT)',
      },
      extraSql: ['CREATE INDEX orders_status ON orders(status)'],
    };
    const db = new FakeDbInspector({ app: [orders] });
    expect(await db.schemaSql('app')).toEqual([
      'CREATE TABLE orders(id INTEGER PRIMARY KEY, status TEXT)',
      'CREATE INDEX orders_status ON orders(status)',
    ]);
    await expect(db.schemaSql('missing')).rejects.toThrow(/No database/);
    // A fresh array each time: a caller may change its copy.
    expect(await db.schemaSql('app')).not.toBe(await db.schemaSql('app'));
  });

  it('notifies watchers on insert and uses the custom handler', async () => {
    const db = new FakeDbInspector({ app: [ordersTable()] }, (_db, sql) =>
      sql.includes('count') ? { columns: ['n'], rows: [[3]] } : undefined,
    );
    const changed = vi.fn();
    db.watch('app', 'orders', changed);
    await db.insert('app', 'orders', [3, 'pending']);
    expect(changed).toHaveBeenCalledOnce();
    expect((await db.query('app', 'select count(*) as n from orders')).rows).toEqual([[3]]);
    await expect(db.query('app', 'delete from orders')).rejects.toThrow(/can't run/);
  });
});

describe('FakeTaskProvider', () => {
  it('filters by status type and updates status', async () => {
    const tasks = new FakeTaskProvider([
      fakeTask(),
      fakeTask({ id: 'i2', key: 'ENG-124', statusType: 'completed' }),
    ]);
    expect((await tasks.myTasks({ statusTypes: ['unstarted'] })).map((t) => t.key)).toEqual([
      'ENG-123',
    ]);
    await tasks.setStatus('ENG-123', 'started');
    expect((await tasks.getTask('issue-uuid-1')).statusType).toBe('started');
    await expect(tasks.getTask('ENG-999')).rejects.toThrow();
  });
});
