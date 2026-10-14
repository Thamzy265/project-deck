import type { DeckEvents, LogEntry } from '@project-deck/core';
import { ActivityListSchema, EventBus, Registry, StatusResponse } from '@project-deck/core';
import { FakeAppConnector, fakeApp } from '@project-deck/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { createApi } from './api.js';
import { ActivityFeed } from './activity.js';
import { AppManager } from './app-manager.js';
import { LoginWindow } from './login-window.js';

const PORT = 9100;
const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';

async function setup() {
  const registry = new Registry();
  const connector = new FakeAppConnector('fake', [fakeApp()]);
  registry.connectors.register(connector);
  const bus = new EventBus<DeckEvents>();
  const activity = new ActivityFeed(bus);
  activity.start();
  const manager = new AppManager(registry, bus);
  await manager.start();
  await vi.waitFor(() => expect(manager.attachedApp()).toBeDefined());
  const shutdown = vi.fn();
  const api = createApi({
    manager,
    bus,
    activity,
    token: TOKEN,
    sessionSecret: 'session-secret-0123456789abcdef0123456789abcdef',
    loginWindow: new LoginWindow(),
    port: () => PORT,
    version: '0.0.0',
    projectId: '0123456789ab',
    projectName: 'shop_app',
    shutdown,
  });

  const request = (
    path: string,
    init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> } = {},
  ) =>
    api.request(`http://127.0.0.1:${PORT}${path}`, {
      ...init,
      headers: { host: `127.0.0.1:${PORT}`, 'x-deck-token': TOKEN, ...init.headers },
    });
  return { api, bus, connector, manager, request, shutdown };
}

describe('API security', () => {
  it('rejects foreign Host headers (DNS rebinding)', async () => {
    const { request } = await setup();
    const res = await request('/api/status', { headers: { host: 'evil.example:9100' } });
    expect(res.status).toBe(403);
  });

  it('rejects cross-origin browser requests', async () => {
    const { request } = await setup();
    const res = await request('/api/reload', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });

  it('requires the token everywhere except health', async () => {
    const { api, request } = await setup();
    expect((await request('/api/status', { headers: { 'x-deck-token': 'wrong' } })).status).toBe(
      401,
    );
    const bearer = await api.request(`http://127.0.0.1:${PORT}/api/status`, {
      headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}` },
    });
    expect(bearer.status).toBe(200);
    expect((await request('/api/health', { headers: { 'x-deck-token': 'wrong' } })).status).toBe(
      200,
    );
  });
});

describe('API routes', () => {
  it('reports status', async () => {
    const { request } = await setup();
    const body = await (await request('/api/status')).json();
    expect(body).toMatchObject({
      dashboardUrl: 'http://127.0.0.1:9100/',
      projectName: 'shop_app',
      discovering: false,
      apps: [fakeApp()],
      attached: fakeApp(),
    });
    expect(StatusResponse.safeParse(body).success).toBe(true);
  });

  it('reloads, restarts and detaches', async () => {
    const { request, connector } = await setup();
    expect(await (await request('/api/reload', { method: 'POST' })).json()).toMatchObject({
      ok: true,
      kind: 'hot-reload',
    });
    expect(await (await request('/api/restart', { method: 'POST' })).json()).toMatchObject({
      ok: true,
      kind: 'hot-restart',
    });
    await request('/api/detach', { method: 'POST' });
    expect(connector.sessions.get('app-1')?.detached).toBe(true);
    expect(await (await request('/api/reload', { method: 'POST' })).json()).toMatchObject({
      reason: 'not-attached',
    });
  });

  it('attaches by id and 404s unknown apps', async () => {
    const { request } = await setup();
    expect((await request('/api/apps/app-1/attach', { method: 'POST' })).status).toBe(200);
    expect((await request('/api/apps/nope/attach', { method: 'POST' })).status).toBe(404);
  });

  it('queries logs with filters and flags truncation', async () => {
    const { request, connector } = await setup();
    const logsAt = async (path: string) =>
      (await (await request(path)).json()) as { entries: LogEntry[]; truncated: boolean };
    const logs = connector.sessions.get('app-1')?.logs();
    for (let i = 0; i < 5; i++) {
      logs?.push({ ts: i, level: i % 2 ? 'error' : 'info', source: 'app', message: `m${i}` });
    }
    const all = await logsAt('/api/logs?limit=2');
    expect(all).toMatchObject({ truncated: true });
    expect(all.entries.map((e) => e.message)).toEqual(['m3', 'm4']);

    const errors = await logsAt('/api/logs?minLevel=error');
    expect(errors).toMatchObject({ truncated: false });
    expect(errors.entries.map((e) => e.message)).toEqual(['m1', 'm3']);

    expect((await request('/api/logs?minLevel=loud')).status).toBe(400);
    expect((await request('/api/logs?limit=abc')).status).toBe(400);

    await request('/api/logs', { method: 'DELETE' });
    expect((await logsAt('/api/logs')).entries).toEqual([]);
  });

  it('tells every client when the logs were cleared (BUG-M2-T2)', async () => {
    const { request, bus } = await setup();
    const cleared = vi.fn();
    bus.on('logs.cleared', cleared);
    const before = Date.now();
    expect((await request('/api/logs', { method: 'DELETE' })).status).toBe(200);
    expect(cleared).toHaveBeenCalledTimes(1);
    const at = (cleared.mock.calls[0]?.[0] as { at: number }).at;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });

  it('turns hook events into bus events', async () => {
    const { request, bus } = await setup();
    const waiting = vi.fn();
    bus.on('claude.waiting', waiting);
    const res = await request('/api/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'claude.waiting', message: 'Allow edit?' }),
    });
    expect(res.status).toBe(200);
    expect(waiting).toHaveBeenCalledWith({ message: 'Allow edit?' });

    expect((await request('/api/events', { method: 'POST', body: 'not json' })).status).toBe(400);
    expect(
      (await request('/api/events', { method: 'POST', body: JSON.stringify({ type: 'other' }) }))
        .status,
    ).toBe(400);
  });

  it('shuts down on request', async () => {
    const { request, shutdown } = await setup();
    await request('/api/shutdown', { method: 'POST' });
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalled());
  });
});

describe('security headers', () => {
  const expectHeaders = (res: Response) => {
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    );
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  };

  it('are on every response, including errors', async () => {
    const { request } = await setup();
    const responses = [
      await request('/api/health'),
      await request('/api/status'),
      await request('/api/status', { headers: { 'x-deck-token': 'wrong' } }),
      await request('/api/status', { headers: { host: 'evil.example:9100' } }),
      await request('/api/nope'),
      await request('/api/events', { method: 'POST', body: 'not json' }),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 200, 401, 403, 404, 400]);
    for (const res of responses) expectHeaders(res);
  });

  it('forbid caching of API JSON', async () => {
    const { request } = await setup();
    for (const path of ['/api/health', '/api/status', '/api/logs']) {
      expect((await request(path)).headers.get('cache-control')).toBe('no-store');
    }
    const denied = await request('/api/status', { headers: { 'x-deck-token': 'wrong' } });
    expect(denied.headers.get('cache-control')).toBe('no-store');
  });
});

describe('GET /api/activity', () => {
  it('lists what happened, oldest first', async () => {
    const { request } = await setup();
    await request('/api/reload', { method: 'POST' });
    await request('/api/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'claude.done', sessionId: 's1' }),
    });
    const res = await request('/api/activity');
    expect(res.status).toBe(200);
    const body = ActivityListSchema.parse(await res.json());
    expect(body.entries.map((e) => e.kind)).toEqual([
      'app.attached',
      'app.reloaded',
      'claude.done',
    ]);
  });

  it('needs the token', async () => {
    const { request } = await setup();
    expect((await request('/api/activity', { headers: { 'x-deck-token': 'wrong' } })).status).toBe(
      401,
    );
  });

  it("never keeps a Stop hook's last assistant message", async () => {
    const { request } = await setup();
    const res = await request('/api/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'claude.done',
        last_assistant_message: 'The plan is secret',
        transcript_path: '/home/me/t.jsonl',
      }),
    });
    expect(res.status).toBe(200);
    const text = await (await request('/api/activity')).text();
    expect(text).not.toContain('secret');
    expect(text).not.toContain('jsonl');
  });
});
