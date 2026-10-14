import { describe, expect, it } from 'vitest';
import { LogsResponse, StatusResponse, WsMessageSchema } from './api.js';
import { fakeApp } from './testing/index.js';

const entry = { ts: 1, level: 'info', source: 'app', message: 'hi' } as const;

describe('dashboard response schemas', () => {
  it('read a status answer with the project folder name', () => {
    const status = {
      version: '0.0.0',
      dashboardUrl: 'http://127.0.0.1:9147/',
      projectName: 'shop_app',
      discovering: false,
      apps: [fakeApp()],
      attached: null,
    };
    expect(StatusResponse.parse(status)).toEqual(status);
    expect(StatusResponse.safeParse({ ...status, projectName: undefined }).success).toBe(false);
    expect(StatusResponse.safeParse({ ...status, discovering: undefined }).success).toBe(false);
  });

  it('read a logs answer', () => {
    expect(LogsResponse.parse({ entries: [entry], truncated: true }).entries).toHaveLength(1);
    expect(LogsResponse.safeParse({ entries: [{ ...entry, level: 'loud' }] }).success).toBe(false);
  });

  it('read every WebSocket message the dashboard uses', () => {
    const messages = [
      { type: 'hello', payload: { apps: [fakeApp()], attached: fakeApp(), discovering: true } },
      { type: 'apps.discovering', payload: { discovering: false } },
      { type: 'heartbeat' },
      { type: 'apps.changed', payload: { connectorId: 'dart', apps: [] } },
      { type: 'app.attached', payload: { app: fakeApp() } },
      { type: 'app.detached', payload: { appId: 'app-1' } },
      {
        type: 'app.reloaded',
        payload: { appId: 'app-1', result: { ok: true, kind: 'hot-reload' } },
      },
      { type: 'app.exit', payload: { appId: 'app-1', crashed: false } },
      { type: 'app.log', payload: { appId: 'app-1', entry } },
      { type: 'activity', payload: { id: 0, ts: 1, kind: 'claude.done' } },
    ];
    for (const message of messages) expect(WsMessageSchema.parse(message)).toEqual(message);
  });

  it('refuse unknown or malformed messages', () => {
    expect(WsMessageSchema.safeParse({ type: 'task.current', payload: {} }).success).toBe(false);
    expect(WsMessageSchema.safeParse({ type: 'app.log', payload: { appId: 'x' } }).success).toBe(
      false,
    );
  });
});
