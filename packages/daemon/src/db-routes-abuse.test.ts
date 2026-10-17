/**
 * Tester probes for the `/api/db` routes (design review S1, ADR 0003): a token caller
 * reaching an edit by any route shape, the cookie and token caller kinds, and the
 * request id's binding under replay and concurrency.
 */
import type { DeckEvents } from '@project-deck/core';
import { EventBus, Registry } from '@project-deck/core';
import type { FakeTable } from '@project-deck/core/testing';
import { FakeAppConnector, FakeDbInspector, fakeApp } from '@project-deck/core/testing';
import { registerDrift } from '@project-deck/db-drift';
import { FakeDriftApp } from '@project-deck/db-drift/testing';
import type { SqlGuard } from '@project-deck/sql-guard';
import { createSqlGuard } from '@project-deck/sql-guard';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ActivityFeed } from './activity.js';
import { createApi } from './api.js';
import { AppManager } from './app-manager.js';
import type { DbSettings } from './db-service.js';
import { DbService } from './db-service.js';
import { LoginWindow } from './login-window.js';

const PORT = 9100;
const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const SECRET = 'session-secret-0123456789abcdef0123456789abcdef';
const ORIGIN = `http://127.0.0.1:${PORT}`;
const COOKIE = `deck_session_${PORT}=${SECRET}`;

const realGuard: SqlGuard = createSqlGuard();
afterAll(async () => {
  await realGuard.close();
});

/** A users table with an email column the config hides from Claude. */
const usersTable = (): FakeTable => ({
  info: {
    name: 'users',
    kind: 'table',
    sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)',
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false, pk: true, pkPosition: 1, default: null },
      { name: 'name', type: 'TEXT', nullable: true, pk: false, default: null },
      { name: 'email', type: 'TEXT', nullable: true, pk: false, default: null },
    ],
    foreignKeys: [],
    indexes: [],
  },
  rows: [[1, 'Ann', 'ann@example.com']],
});

async function setup(settings: Partial<DbSettings> = {}) {
  const drift = new FakeDriftApp();
  const crm = new FakeDbInspector({ crm: [usersTable()] }, undefined, { id: 'crm' });
  const registry = new Registry();
  registerDrift(registry);
  registry.dbInspectors.register({ id: crm.id, create: () => Promise.resolve(crm) });
  registry.connectors.register(
    new FakeAppConnector('fake', [fakeApp()], () => ({ extensions: drift.extensions })),
  );
  const bus = new EventBus<DeckEvents>();
  const db = new DbService({
    registry,
    bus,
    guard: realGuard,
    settings: { allowWrites: true, hiddenColumns: ['users.email'], ...settings },
  });
  const manager = new AppManager(registry, bus, { onSession: (app, s) => db.attach(app, s) });
  await manager.start();
  await vi.waitFor(() => expect(manager.attachedApp()).toBeDefined());
  const api = createApi({
    manager,
    bus,
    activity: new ActivityFeed(bus),
    token: TOKEN,
    sessionSecret: SECRET,
    loginWindow: new LoginWindow(),
    port: () => PORT,
    version: '0.0.0',
    projectId: undefined,
    projectName: 'shop_app',
    db,
    shutdown: () => undefined,
  });
  const send = (
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> },
  ) =>
    api.request(`${ORIGIN}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      headers: { host: `127.0.0.1:${PORT}`, 'content-type': 'application/json', ...init.headers },
    });
  const dashboard = { cookie: COOKIE, origin: ORIGIN, 'sec-fetch-site': 'same-origin' };
  return { drift, crm, bus, send, dashboard };
}

const EDIT = {
  db: 'app',
  sql: 'UPDATE orders SET status = ? WHERE id = ?',
  params: ['shipped', 1],
};

describe('/api/db edits: a token caller never reaches them (tester probes)', () => {
  it('refuses the token by every header form, also with the dashboard cookie and origin', async () => {
    const { send, drift, dashboard } = await setup();
    for (const headers of [
      { 'x-deck-token': TOKEN },
      { authorization: `Bearer ${TOKEN}` },
      { authorization: `bearer ${TOKEN}` },
      { 'x-deck-token': TOKEN, origin: ORIGIN },
      { ...dashboard, 'x-deck-token': TOKEN },
      { ...dashboard, authorization: `Bearer ${TOKEN}` },
    ]) {
      for (const path of ['/api/db/execute', '/api/db/execute/confirm', '/api/db/execute/cancel']) {
        const body =
          path === '/api/db/execute' ? EDIT : { requestId: 'a'.repeat(32), sql: EDIT.sql };
        const res = await send(path, { body, headers });
        expect(res.status, `${path} ${Object.keys(headers).join('+')}`).toBe(403);
      }
    }
    expect(drift.executed).toEqual([]);
  });

  it('gives no request id for path, case, slash, query or method variants', async () => {
    const { send, drift } = await setup();
    const headers = { 'x-deck-token': TOKEN };
    const variants: { path: string; method?: string; headers?: Record<string, string> }[] = [
      { path: '/api/db/execute/' },
      { path: '/api/db/execute?x=1' },
      { path: '/API/db/execute' },
      { path: '/api/DB/execute' },
      { path: '/api/db/Execute' },
      { path: '/api/db//execute' },
      { path: '/api//db/execute' },
      { path: '/api/db/%65xecute' },
      { path: '/api/db/execute%2F' },
      { path: '/api/db/./execute' },
      { path: '/api/db/query/../execute' },
      { path: '/api/db/execute;x' },
      { path: '/api/db/execute', method: 'PUT' },
      { path: '/api/db/execute', method: 'PATCH' },
      { path: '/api/db/execute', method: 'POST', headers: { 'x-http-method-override': 'GET' } },
      { path: '/api/db/query', method: 'POST', headers: { 'x-http-method-override': 'PUT' } },
      { path: '/api/db/query?_method=EXECUTE' },
    ];
    for (const v of variants) {
      const res = await send(v.path, {
        method: v.method ?? 'POST',
        body: EDIT,
        headers: { ...headers, ...v.headers },
      });
      const text = await res.text();
      expect(text, `${v.method ?? 'POST'} ${v.path}`).not.toContain('requestId');
      expect([400, 403, 404, 405, 422], `${v.method ?? 'POST'} ${v.path}`).toContain(res.status);
    }
    expect(drift.executed).toEqual([]);
  });

  it('answers GET on the POST-only db routes with 404, not a handler', async () => {
    const { send } = await setup();
    for (const path of [
      '/api/db/query',
      '/api/db/execute',
      '/api/db/execute/confirm',
      '/api/db/snapshot',
      '/api/db/diff',
      '/api/db/refresh',
    ]) {
      const res = await send(path, { method: 'GET', headers: { 'x-deck-token': TOKEN } });
      expect(res.status, path).toBe(404);
    }
  });
});

describe('/api/db caller kinds (tester probes)', () => {
  it('refuses a cookie sent from another site, or with an origin other than its host', async () => {
    const { send } = await setup();
    for (const headers of [
      { cookie: COOKIE, 'sec-fetch-site': 'same-site' },
      { cookie: COOKIE, 'sec-fetch-site': 'cross-site' },
      { cookie: COOKIE, origin: `http://localhost:${PORT}` },
      { cookie: `deck_session_${PORT + 1}=${SECRET}`, origin: ORIGIN },
      { cookie: `deck_session_${PORT}=${SECRET}x`, origin: ORIGIN },
    ]) {
      const res = await send('/api/db/query', {
        body: { db: 'crm', sql: 'SELECT email FROM users' },
        headers,
      });
      expect([401, 403], JSON.stringify(headers)).toContain(res.status);
    }
  });

  it('treats a caller with the token as Claude even when the dashboard cookie comes too', async () => {
    const { send, dashboard } = await setup();
    const res = await send('/api/db/query', {
      body: { db: 'crm', sql: 'SELECT email FROM users' },
      headers: { ...dashboard, 'x-deck-token': TOKEN },
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'refused' });
  });

  it('hides the column from a token caller through alias, expression, subquery and view-like forms', async () => {
    const { send } = await setup();
    for (const sql of [
      'SELECT email AS e FROM users',
      'SELECT upper(email) FROM users',
      'SELECT * FROM users',
      'SELECT u.EMAIL FROM users u',
      'SELECT (SELECT email FROM users LIMIT 1)',
      "SELECT id FROM users WHERE email LIKE 'a%'",
      'SELECT "email" FROM "USERS"',
      'SELECT json_group_array(email) FROM users',
    ]) {
      const res = await send('/api/db/query', {
        body: { db: 'crm', sql },
        headers: { 'x-deck-token': TOKEN },
      });
      expect(res.status, sql).toBe(422);
    }
  });

  it('drops the hidden column from a token caller diff and keeps it for the dashboard', async () => {
    const { send, crm, dashboard } = await setup();
    const token = { 'x-deck-token': TOKEN };
    const snapAs = async (headers: Record<string, string>) =>
      (
        (await (await send('/api/db/snapshot', { body: { db: 'crm' }, headers })).json()) as {
          id: string;
        }
      ).id;
    const claudeSnap = await snapAs(token);
    const dashSnap = await snapAs(dashboard);
    await crm.insert('crm', 'users', [2, 'Bob', 'bob@example.com']);
    const claude = await (
      await send('/api/db/diff', { body: { db: 'crm', snapshotId: claudeSnap }, headers: token })
    ).text();
    expect(claude).toContain('Bob');
    expect(claude).not.toContain('bob@example.com');
    expect(claude).not.toContain('"email"');
    const dash = await (
      await send('/api/db/diff', { body: { db: 'crm', snapshotId: dashSnap }, headers: dashboard })
    ).text();
    expect(dash).toContain('bob@example.com');
  });
});

describe('/api/db edit request id (tester probes)', () => {
  async function requested() {
    const ctx = await setup();
    const res = await ctx.send('/api/db/execute', { body: EDIT, headers: ctx.dashboard });
    expect(res.status).toBe(200);
    const { requestId } = (await res.json()) as { requestId: string };
    const confirm = (body: Record<string, unknown>) =>
      ctx.send('/api/db/execute/confirm', { body: { requestId, ...body }, headers: ctx.dashboard });
    return { ...ctx, requestId, confirm };
  }

  it('runs exactly one of several concurrent confirms', async () => {
    const { confirm, drift } = await requested();
    const results = await Promise.all(
      Array.from({ length: 8 }, async () => confirm({ sql: EDIT.sql, params: EDIT.params })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409, 409, 409, 409]);
    expect(drift.executed).toHaveLength(1);
  });

  it('refuses a confirm whose SQL or parameters differ in any way, and uses the id up', async () => {
    for (const body of [
      { sql: `${EDIT.sql} `, params: EDIT.params },
      { sql: EDIT.sql.toLowerCase(), params: EDIT.params },
      { sql: EDIT.sql, params: ['shipped', '1'] },
      { sql: EDIT.sql, params: ['shipped', 1.0000001] },
      { sql: EDIT.sql, params: [1, 'shipped'] },
      { sql: EDIT.sql, params: ['shipped', 1, null] },
      { sql: EDIT.sql },
      { sql: EDIT.sql, params: ['shipped\u0000', 1] },
      { sql: EDIT.sql, params: ['shippéd', 1] },
    ]) {
      const { confirm, drift } = await requested();
      const res = await confirm(body);
      expect(res.status, JSON.stringify(body)).toBe(409);
      // The id is used up: the right SQL afterwards is refused too.
      expect((await confirm({ sql: EDIT.sql, params: EDIT.params })).status).toBe(409);
      expect(drift.executed).toEqual([]);
    }
  });

  it('runs the edit on the database it was asked for, whatever db the confirm names', async () => {
    const { confirm, drift } = await requested();
    const res = await confirm({ db: 'crm', sql: EDIT.sql, params: EDIT.params });
    expect(res.status).toBe(200);
    expect(drift.executed.map((e) => e.db)).toEqual(['app']);
  });

  it('refuses a confirm after a hot restart, and a request id that was never issued', async () => {
    const { confirm, bus, send, dashboard } = await requested();
    bus.emit('app.reloaded', { appId: 'app-1', result: { ok: true, kind: 'hot-restart' } });
    expect((await confirm({ sql: EDIT.sql, params: EDIT.params })).status).toBe(409);
    const made = await send('/api/db/execute/confirm', {
      body: { requestId: 'A'.repeat(32), sql: EDIT.sql, params: EDIT.params },
      headers: dashboard,
    });
    expect(made.status).toBe(409);
  });

  it('refuses request ids of the wrong shape with 400 before looking them up', async () => {
    const { send, dashboard } = await setup();
    for (const requestId of ['', 'a'.repeat(31), 'a'.repeat(33), `${'a'.repeat(31)}=`, 7]) {
      const res = await send('/api/db/execute/confirm', {
        body: { requestId, sql: EDIT.sql },
        headers: dashboard,
      });
      expect(res.status, String(requestId)).toBe(400);
    }
  });

  it('refuses an edit request with writes off, from the dashboard too', async () => {
    const { send, dashboard, drift } = await setup({ allowWrites: false });
    const res = await send('/api/db/execute', { body: EDIT, headers: dashboard });
    expect(res.status).toBe(403);
    expect(drift.executed).toEqual([]);
  });
});
