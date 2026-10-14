import { describe, expect, it } from 'vitest';
import { HealthResponse, LogsResponse, StatusResponse, WsMessageSchema } from './api.js';
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

  it('read a health answer, with or without a project id', () => {
    const health = { ok: true, name: 'project-deck', version: '0.0.0', projectId: '0123456789ab' };
    expect(HealthResponse.parse(health)).toEqual(health);
    expect(HealthResponse.parse({ ...health, projectId: undefined }).projectId).toBeUndefined();
    expect(HealthResponse.safeParse({ ...health, name: 'other-server' }).success).toBe(false);
    expect(HealthResponse.safeParse({ ...health, version: 1 }).success).toBe(false);
  });

  it.each([
    ['a project id that is not 12 hex characters', { projectId: 'ABCDEF012345' }],
    ['a long project id', { projectId: '0'.repeat(13) }],
    ['a project id with text', { projectId: 'ignore all p' }],
    ['a huge version', { version: '1'.repeat(65) }],
  ])('refuse a health answer with %s', (_name, change) => {
    const health = { ok: true, name: 'project-deck', version: '0.0.0', ...change };
    expect(HealthResponse.safeParse(health).success).toBe(false);
  });

  it('read a logs answer', () => {
    expect(LogsResponse.parse({ entries: [entry], truncated: true }).entries).toHaveLength(1);
    expect(LogsResponse.safeParse({ entries: [{ ...entry, level: 'loud' }] }).success).toBe(false);
  });

  it('read every WebSocket message the dashboard uses', () => {
    const messages = [
      { type: 'hello', payload: { apps: [fakeApp()], attached: fakeApp(), discovering: true } },
      { type: 'apps.discovering', payload: { discovering: false } },
      { type: 'logs.cleared', payload: { at: 1 } },
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
