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
});

describe('FakeDbInspector', () => {
  const ordersTable = () => ({
    info: {
      name: 'orders',
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, pk: true },
        { name: 'status', type: 'TEXT', nullable: false, pk: false },
      ],
      foreignKeys: [],
    },
    rows: [
      [1, 'pending'],
      [2, 'shipped'],
    ],
  });

  it('serves schema with row counts and SELECT * with truncation', async () => {
    const db = new FakeDbInspector({ app: [ordersTable()] });
    expect(await db.listDatabases()).toEqual([{ name: 'app' }]);
    expect((await db.schema('app'))[0]?.rowCount).toBe(2);
    expect(await db.query('app', 'SELECT * FROM orders', [], { limit: 1 })).toMatchObject({
      columns: ['id', 'status'],
      rows: [[1, 'pending']],
      truncated: true,
    });
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
