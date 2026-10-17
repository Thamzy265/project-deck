import type { DeckEvents } from '@project-deck/core';
import { EventBus, Registry } from '@project-deck/core';
import type { FakeTable } from '@project-deck/core/testing';
import { FakeAppSession, FakeDbInspector, fakeApp } from '@project-deck/core/testing';
import { FakeSqlGuard } from '@project-deck/sql-guard/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { DbService } from './db-service.js';

const users = (views: string[] = []): FakeTable => ({
  info: {
    name: 'users',
    kind: 'table',
    sql: 'CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT, secret TEXT)',
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false, pk: true, pkPosition: 1, default: null },
      { name: 'name', type: 'TEXT', nullable: true, pk: false, default: null },
      { name: 'secret', type: 'TEXT', nullable: true, pk: false, default: null },
    ],
    foreignKeys: [],
    indexes: [],
  },
  rows: [[1, 'Ada', 's']],
  extraSql: ['CREATE VIEW user_list AS SELECT id, name, secret FROM users', ...views],
});

const services: DbService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()));
});

async function setup(guard: FakeSqlGuard, views: string[] = []) {
  const db = new FakeDbInspector({ app: [users(views)] });
  const registry = new Registry();
  registry.dbInspectors.register({ id: db.id, create: () => Promise.resolve(db) });
  const service = new DbService({
    registry,
    bus: new EventBus<DeckEvents>(),
    guard,
    settings: { allowWrites: false, hiddenColumns: ['users.secret'] },
  });
  services.push(service);
  const app = fakeApp();
  await service.attach(app, new FakeAppSession(app));
  return service;
}

const HIDDEN =
  'The statement reads users.secret, which is hidden (db.hiddenColumns). Leave it out; if you used *, list the columns you need.';

describe('DbService: refusals', () => {
  it("keeps the gate's code with the refusal", async () => {
    const service = await setup(
      new FakeSqlGuard().refuse('DELETE FROM users', 'writes-data', 'It changes data.'),
    );
    await expect(
      service.query({ db: 'app', sql: 'DELETE FROM users' }, 'dashboard'),
    ).rejects.toMatchObject({ code: 'refused', detail: 'writes-data' });
  });

  it('tells Claude a view that reads a hidden column is refused whole (QA G1)', async () => {
    const sql = 'SELECT name FROM user_list';
    const service = await setup(new FakeSqlGuard().refuse(sql, 'hidden-column', HIDDEN));
    await expect(service.query({ db: 'app', sql }, 'claude')).rejects.toMatchObject({
      code: 'refused',
      detail: 'hidden-column',
      message: `${HIDDEN} user_list is a view that reads a hidden column, so it can't be read at all, even its other columns.`,
    });
  });

  it('adds nothing about a view whose body reads no table with hidden columns (R7)', async () => {
    const sql = 'SELECT secret FROM users JOIN item_names USING (id)';
    const service = await setup(new FakeSqlGuard().refuse(sql, 'hidden-column', HIDDEN), [
      'CREATE VIEW item_names AS SELECT 1 AS id',
    ]);
    await expect(service.query({ db: 'app', sql }, 'claude')).rejects.toMatchObject({
      message: HIDDEN,
    });
  });

  it('adds nothing about views when the statement names none', async () => {
    const sql = 'SELECT secret FROM users';
    const service = await setup(new FakeSqlGuard().refuse(sql, 'hidden-column', HIDDEN));
    await expect(service.query({ db: 'app', sql }, 'claude')).rejects.toMatchObject({
      message: HIDDEN,
    });
  });
});
