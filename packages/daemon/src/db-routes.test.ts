import type { DeckEvents } from '@project-deck/core';
import type { SavedQuery } from '@project-deck/core';
import { DbError, DbListResponse, EventBus, Registry } from '@project-deck/core';
import { FakeAppConnector, FakeDbInspector, fakeApp } from '@project-deck/core/testing';
import { registerDrift } from '@project-deck/db-drift';
import { FakeDriftApp } from '@project-deck/db-drift/testing';
import type { SqlGuard } from '@project-deck/sql-guard';
import { createSqlGuard } from '@project-deck/sql-guard';
import { FakeSqlGuard } from '@project-deck/sql-guard/testing';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ActivityFeed } from './activity.js';
import { createApi } from './api.js';
import { AppManager } from './app-manager.js';
import type { DbRouteContext } from './db-routes.js';
import { DB_BODY_LIMIT } from './db-routes.js';
import type { DbSettings } from './db-service.js';
import { DbService } from './db-service.js';
import { LoginWindow } from './login-window.js';

const PORT = 9100;
const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const SECRET = 'session-secret-0123456789abcdef0123456789abcdef';
const ORIGIN = `http://127.0.0.1:${PORT}`;

// One real gate (ADR 0005) for the whole file: its wasm engine loads once.
const realGuard = createSqlGuard();
afterAll(async () => {
  await realGuard.close();
});

interface SetupOptions {
  queries?: DbRouteContext['queries'];
  settings?: Partial<DbSettings>;
  guard?: SqlGuard;
  extraDb?: FakeDbInspector;
}

async function setup(opts: SetupOptions = {}) {
  const drift = new FakeDriftApp();
  const registry = new Registry();
  registerDrift(registry);
  if (opts.extraDb !== undefined) {
    const extra = opts.extraDb;
    registry.dbInspectors.register({ id: extra.id, create: () => Promise.resolve(extra) });
  }
  registry.connectors.register(
    new FakeAppConnector('fake', [fakeApp()], () => ({ extensions: drift.extensions })),
  );
  const bus = new EventBus<DeckEvents>();
  const db = new DbService({
    registry,
    bus,
    guard: opts.guard ?? realGuard,
    settings: { allowWrites: false, hiddenColumns: [], ...opts.settings },
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
    ...(opts.queries === undefined ? {} : { queries: opts.queries }),
    shutdown: () => undefined,
  });
  type Init = { method?: string; body?: unknown; headers?: Record<string, string> };
  const send = (path: string, init: Init, auth: Record<string, string>) =>
    api.request(`${ORIGIN}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      headers: {
        host: `127.0.0.1:${PORT}`,
        'content-type': 'application/json',
        ...auth,
        ...init.headers,
      },
    });
  /** As the MCP server or the CLI: the runtime.json token. */
  const asToken = (path: string, init: Init = {}) => send(path, init, { 'x-deck-token': TOKEN });
  /** As the dashboard: its cookie, from its own origin. */
  const asDashboard = (path: string, init: Init = {}) =>
    send(path, init, {
      cookie: `deck_session_${PORT}=${SECRET}`,
      origin: ORIGIN,
      'sec-fetch-site': 'same-origin',
    });
  return { drift, asToken, asDashboard, send, manager, db };
}

/** A snapshot backend that needs the user to pick a device first. */
class ChoosyDb extends FakeDbInspector {
  chosen: string | undefined;
  constructor() {
    super({ 'app_flutter/app.sqlite': [] }, undefined, { id: 'sqlite-file', live: false });
  }
  override listDatabases() {
    if (this.chosen === undefined) {
      return Promise.reject(
        new DbError('choose-device', 'Pick one.', {
          devices: [
            { id: 'emulator-5554', name: 'emulator-5554' },
            { id: 'R58M123ABC', name: 'R58M123ABC' },
          ],
        }),
      );
    }
    return super.listDatabases();
  }
  chooseDevice(id: string): Promise<void> {
    this.chosen = id;
    return Promise.resolve();
  }
}

describe('/api/db/queries (saved queries)', () => {
  it('reads and replaces the saved queries, from the dashboard only', async () => {
    const saved: SavedQuery[][] = [];
    const queries = {
      read: () => Promise.resolve(saved.at(-1) ?? []),
      write: (q: SavedQuery[]) => {
        saved.push(q);
        return Promise.resolve();
      },
    };
    const { asToken, asDashboard, send } = await setup({ guard: new FakeSqlGuard(), queries });
    expect(await (await asDashboard('/api/db/queries')).json()).toEqual({ queries: [] });
    // The browser sends no Origin with a same-origin GET.
    const noOrigin = await send(
      '/api/db/queries',
      {},
      { cookie: `deck_session_${PORT}=${SECRET}`, 'sec-fetch-site': 'same-origin' },
    );
    expect(noOrigin.status).toBe(200);
    const list = [{ name: 'Pending', sql: 'SELECT 1' }];
    const put = await asDashboard('/api/db/queries', { method: 'PUT', body: { queries: list } });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ queries: list });
    expect(saved).toEqual([list]);
    expect((await asToken('/api/db/queries')).status).toBe(403);
    const byToken = await asToken('/api/db/queries', { method: 'PUT', body: { queries: [] } });
    expect(byToken.status).toBe(403);
    for (const body of [
      {},
      { queries: [{ name: '', sql: 'SELECT 1' }] },
      { queries: [{ name: 'x'.repeat(101), sql: 'SELECT 1' }] },
      { queries: Array(201).fill({ name: 'a', sql: 'SELECT 1' }) },
    ]) {
      const res = await asDashboard('/api/db/queries', { method: 'PUT', body });
      expect(res.status).toBe(400);
    }
    expect(saved).toHaveLength(1);
  });
});

describe('/api/db/device (choose-device)', () => {
  it('lists the devices to pick from, and lists databases once the user picked', async () => {
    const choosy = new ChoosyDb();
    const { asDashboard } = await setup({ guard: new FakeSqlGuard(), extraDb: choosy });
    const before = DbListResponse.parse(await (await asDashboard('/api/db')).json());
    expect(before.sources.find((s) => s.id === 'sqlite-file')?.error).toEqual({
      code: 'choose-device',
      message: 'Pick one.',
      devices: [
        { id: 'emulator-5554', name: 'emulator-5554' },
        { id: 'R58M123ABC', name: 'R58M123ABC' },
      ],
    });
    const res = await asDashboard('/api/db/device', {
      body: { source: 'sqlite-file', device: 'R58M123ABC' },
    });
    expect(res.status).toBe(200);
    const after = DbListResponse.parse(await res.json());
    expect(choosy.chosen).toBe('R58M123ABC');
    expect(after.databases).toContainEqual({
      name: 'app_flutter/app.sqlite',
      backend: 'snapshot',
      source: 'sqlite-file',
    });
  });

  it('takes the choice from the dashboard only, and validates it', async () => {
    const choosy = new ChoosyDb();
    const { asToken, asDashboard } = await setup({ guard: new FakeSqlGuard(), extraDb: choosy });
    const token = await asToken('/api/db/device', {
      body: { source: 'sqlite-file', device: 'R58M123ABC' },
    });
    expect(token.status).toBe(403);
    for (const body of [
      {},
      { source: 'sqlite-file' },
      { source: 'sqlite-file', device: '' },
      { source: 'sqlite-file', device: 'x'.repeat(129) },
    ]) {
      expect((await asDashboard('/api/db/device', { body })).status, JSON.stringify(body)).toBe(
        400,
      );
    }
    const unknown = await asDashboard('/api/db/device', {
      body: { source: 'nope', device: 'R58M123ABC' },
    });
    expect(await unknown.json()).toMatchObject({ code: 'not-found' });
    const live = await asDashboard('/api/db/device', {
      body: { source: 'drift', device: 'R58M123ABC' },
    });
    expect(await live.json()).toMatchObject({ code: 'unsupported' });
    expect(choosy.chosen).toBeUndefined();
  });
});

const queryCalls = (drift: FakeDriftApp) =>
  drift.extensions.calls.filter((c) => c.method === 'ext.flutterdeck.drift.v1.query');

describe('/api/db security', () => {
  it('keeps the Host, Origin and token checks on every db route', async () => {
    const { send } = await setup({ guard: new FakeSqlGuard() });
    for (const [path, body] of [
      ['/api/db', undefined],
      ['/api/db/app/schema', undefined],
      ['/api/db/query', { db: 'app', sql: 'SELECT 1' }],
      ['/api/db/snapshot', { db: 'app' }],
      ['/api/db/diff', { db: 'app' }],
      ['/api/db/refresh', { db: 'app' }],
      ['/api/db/execute', { db: 'app', sql: 'DELETE FROM orders' }],
      ['/api/db/execute/confirm', { requestId: 'a'.repeat(32), sql: 'x' }],
      ['/api/db/execute/cancel', { requestId: 'a'.repeat(32) }],
      ['/api/db/device', { source: 'sqlite-file', device: 'emulator-5554' }],
      ['/api/db/queries', undefined],
    ] as const) {
      const init = body === undefined ? {} : { body };
      expect((await send(path, init, {})).status, `${path} without a token`).toBe(401);
      expect((await send(path, init, { 'x-deck-token': 'wrong' })).status, path).toBe(401);
      const evilHost = await send(
        path,
        { ...init, headers: { host: 'evil.example:9100' } },
        { 'x-deck-token': TOKEN },
      );
      expect(evilHost.status, `${path} foreign host`).toBe(403);
      const evilOrigin = await send(
        path,
        { ...init, headers: { origin: 'https://evil.example' } },
        { 'x-deck-token': TOKEN },
      );
      expect(evilOrigin.status, `${path} foreign origin`).toBe(403);
    }
  });

  it('never accepts the runtime.json token for edits, even with writes on', async () => {
    const { asToken, drift } = await setup({
      settings: { allowWrites: true },
      guard: new FakeSqlGuard(),
    });
    const res = await asToken('/api/db/execute', {
      body: { db: 'app', sql: 'DELETE FROM orders' },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'not-allowed' });
    expect(drift.executed).toHaveLength(0);
  });

  it('needs the dashboard origin itself for edits, not just its cookie', async () => {
    const { send } = await setup({ settings: { allowWrites: true }, guard: new FakeSqlGuard() });
    const cookie = { cookie: `deck_session_${PORT}=${SECRET}` };
    const body = { db: 'app', sql: 'DELETE FROM orders' };
    expect((await send('/api/db/execute', { body }, cookie)).status).toBe(403);
    expect(
      (
        await send(
          '/api/db/execute',
          { body },
          { ...cookie, origin: `http://localhost:${PORT}`, host: `localhost:${PORT}` },
        )
      ).status,
    ).toBe(200);
  });

  it('refuses bodies over the limit before reading them', async () => {
    const { asToken } = await setup({ guard: new FakeSqlGuard() });
    const res = await asToken('/api/db/query', {
      body: { db: 'app', sql: 'x'.repeat(DB_BODY_LIMIT) },
    });
    expect(res.status).toBe(413);
  });
});

describe('/api/db with the real read-only gate', () => {
  it('lists the live database and serves its schema', async () => {
    const { asToken } = await setup();
    const list = DbListResponse.parse(await (await asToken('/api/db')).json());
    expect(list.databases).toEqual([{ name: 'app', backend: 'live', source: 'drift' }]);
    const schema = (await (await asToken('/api/db/app/schema')).json()) as {
      tables: { name: string }[];
    };
    expect(schema.tables.map((t) => t.name)).toEqual(['lines', 'orders']);
  });

  it('runs a reading query in the app', async () => {
    const { asToken, drift } = await setup();
    const res = await asToken('/api/db/query', {
      body: {
        db: 'app',
        sql: 'SELECT id, item, status FROM orders WHERE status = ?',
        params: ['pending'],
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ columns: ['id', 'item', 'status'], truncated: false });
    expect(queryCalls(drift)).toHaveLength(1);
  });

  it('refuses every known write shape in the daemon, before it reaches the app', async () => {
    const { asToken, asDashboard, drift } = await setup();
    for (const sql of [
      'DELETE FROM orders',
      'DELETE FROM orders RETURNING *',
      "ATTACH 'other.db' AS x",
      'PRAGMA writable_schema = 1',
      "VACUUM INTO '/tmp/x.db'",
      'SELECT 1; DROP TABLE orders',
      'BEGIN',
      "UPDATE orders SET status = 'x'",
    ]) {
      for (const ask of [asToken, asDashboard]) {
        const res = await ask('/api/db/query', { body: { db: 'app', sql } });
        expect(res.status, sql).toBe(422);
        expect(await res.json(), sql).toMatchObject({ code: 'refused' });
      }
    }
    expect(queryCalls(drift)).toHaveLength(0);
  });

  it("passes the gate's refusal code on as detail, so the dashboard can say why", async () => {
    const { asDashboard } = await setup();
    const cases: [string, string][] = [
      ['DELETE FROM orders', 'writes-data'],
      ['SELECT 1; DROP TABLE orders', 'multiple-statements'],
      ["ATTACH 'other.db' AS x", 'attach'],
      ['PRAGMA writable_schema = 1', 'pragma'],
    ];
    for (const [sql, detail] of cases) {
      const res = await asDashboard('/api/db/query', { body: { db: 'app', sql } });
      expect(await res.json(), sql).toMatchObject({ code: 'refused', detail });
    }
  });

  it('refuses a hidden column to Claude (token) and shows it on the dashboard', async () => {
    const { asToken, asDashboard, drift } = await setup({
      settings: { hiddenColumns: ['orders.item'] },
    });
    const claude = await asToken('/api/db/query', {
      body: { db: 'app', sql: 'SELECT upper(item) AS x FROM orders' },
    });
    expect(claude.status).toBe(422);
    expect(queryCalls(drift)).toHaveLength(0);
    const dashboard = await asDashboard('/api/db/query', {
      body: { db: 'app', sql: 'SELECT item FROM orders' },
    });
    expect(dashboard.status).toBe(200);
  });

  it('caps the row limit at 500 for token callers and 1,000 for the dashboard', async () => {
    const { asToken, asDashboard } = await setup();
    const body = (limit: number) => ({ body: { db: 'app', sql: 'SELECT id FROM orders', limit } });
    expect((await asToken('/api/db/query', body(501))).status).toBe(400);
    expect((await asToken('/api/db/query', body(500))).status).toBe(200);
    expect((await asDashboard('/api/db/query', body(1000))).status).toBe(200);
    expect((await asDashboard('/api/db/query', body(1001))).status).toBe(400);
  });

  it("answers an unsupported query (a Linux app) with the app's state, not a crash", async () => {
    const { asToken, drift } = await setup();
    drift.handle('query', () => ({ error: { code: 'unsupported', message: 'x' } }));
    const res = await asToken('/api/db/query', { body: { db: 'app', sql: 'SELECT 1' } });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'unsupported' });
  });

  it('runs a confirmed dashboard edit once, with a fresh 43-character token', async () => {
    const { asDashboard, drift } = await setup({ settings: { allowWrites: true } });
    const edit = {
      db: 'app',
      sql: 'UPDATE orders SET status = ? WHERE id = ?',
      params: ['shipped', 1],
    };
    const requested = await asDashboard('/api/db/execute', { body: edit });
    expect(requested.status).toBe(200);
    const { requestId, tables } = (await requested.json()) as {
      requestId: string;
      tables: string[];
    };
    expect(tables).toEqual(['orders']);
    expect(drift.executed).toHaveLength(0);
    const confirm = { requestId, sql: edit.sql, params: edit.params };
    const done = await asDashboard('/api/db/execute/confirm', { body: confirm });
    expect(await done.json()).toEqual({ changes: 1 });
    expect([...drift.usedTokens][0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const replay = await asDashboard('/api/db/execute/confirm', { body: confirm });
    expect(replay.status).toBe(409);
    expect(drift.executed).toHaveLength(1);
  });

  it('refuses edits while writes are off', async () => {
    const { asDashboard } = await setup();
    const res = await asDashboard('/api/db/execute', {
      body: { db: 'app', sql: 'DELETE FROM orders WHERE id = 1' },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'not-allowed' });
  });

  it('takes a snapshot and diffs it', async () => {
    const { asToken } = await setup();
    const snap = (await (await asToken('/api/db/snapshot', { body: { db: 'app' } })).json()) as {
      id: string;
    };
    expect(snap.id).toMatch(/^snap-/);
    const diff = await asToken('/api/db/diff', { body: { db: 'app', snapshotId: snap.id } });
    expect(diff.status).toBe(200);
    expect(await diff.json()).toMatchObject({ db: 'app', snapshotId: snap.id, tables: [] });
  });

  it('finds snapshot databases whose names hold a slash', async () => {
    const extraDb = new FakeDbInspector(
      {
        'app_flutter/app.sqlite': [
          {
            info: { name: 't', kind: 'table', columns: [], foreignKeys: [], indexes: [] },
            rows: [],
          },
        ],
      },
      undefined,
      { id: 'sqlite-file', live: false },
    );
    const { asToken } = await setup({ extraDb, guard: new FakeSqlGuard() });
    const res = await asToken(`/api/db/${encodeURIComponent('app_flutter/app.sqlite')}/schema`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      db: 'app_flutter/app.sqlite',
      tables: [{ name: 't' }],
    });
    const missing = await asToken('/api/db/nope/schema');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'No database named nope.', code: 'not-found' });
  });

  it('closes the backends and forgets snapshots when the app is detached', async () => {
    const { asToken, manager } = await setup();
    await asToken('/api/db/snapshot', { body: { db: 'app' } });
    await manager.detach();
    const res = await asToken('/api/db');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'app-gone' });
  });
});

describe('/api/db/:db/schema input', () => {
  it('validates the database name with the shared schema before any backend sees it', async () => {
    const { asToken, drift } = await setup({ guard: new FakeSqlGuard() });
    const before = drift.extensions.calls.length;
    const res = await asToken(`/api/db/${'x'.repeat(129)}/schema`);
    expect(res.status).toBe(400);
    expect(drift.extensions.calls.length).toBe(before);
  });
});
