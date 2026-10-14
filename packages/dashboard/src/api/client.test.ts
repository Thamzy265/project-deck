import { fakeApp } from '@project-deck/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { HttpError, NetworkError, createClient } from './client.js';

const status = {
  version: '0.0.0',
  dashboardUrl: 'http://127.0.0.1:9147/',
  projectName: 'shop_app',
  apps: [fakeApp()],
  attached: fakeApp(),
};

function respond(body: unknown, init: ResponseInit = {}) {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200, ...init })),
  );
}

describe('API client', () => {
  it('sends the cookie, same origin only, and validates the answer', async () => {
    const fetchFn = respond(status);
    const client = createClient(fetchFn);
    expect(await client.status()).toEqual(status);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe('/api/status');
    expect(init?.credentials).toBe('same-origin');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('asks for the latest log lines with a limit', async () => {
    const fetchFn = respond({ entries: [], truncated: false });
    await createClient(fetchFn).logs(500);
    expect(fetchFn.mock.calls[0]?.[0]).toBe('/api/logs?limit=500');
  });

  it('posts actions and reads the reload result', async () => {
    const fetchFn = respond({ ok: false, reason: 'compile-error', message: 'boom' });
    const result = await createClient(fetchFn).reload();
    expect(result).toMatchObject({ ok: false, message: 'boom' });
    expect(fetchFn.mock.calls[0]?.[1]?.method).toBe('POST');
  });

  it('escapes app ids in the attach path', async () => {
    const fetchFn = respond(fakeApp());
    await createClient(fetchFn).attach('a/b?c');
    expect(fetchFn.mock.calls[0]?.[0]).toBe('/api/apps/a%2Fb%3Fc/attach');
  });

  it('reports HTTP errors with their status and message', async () => {
    const client = createClient(respond({ error: 'Missing or invalid token' }, { status: 401 }));
    await expect(client.status()).rejects.toEqual(new HttpError(401, 'Missing or invalid token'));
  });

  it('reports a refused connection as a network error', async () => {
    const client = createClient(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(client.status()).rejects.toBeInstanceOf(NetworkError);
  });

  it('rejects answers that do not match the schema', async () => {
    const client = createClient(respond({ ...status, apps: 'nope' }));
    await expect(client.status()).rejects.toThrow("FlutterDeck's answer wasn't understood");
  });

  it('rejects answers that are not JSON', async () => {
    const client = createClient(() => Promise.resolve(new Response('<html>', { status: 200 })));
    await expect(client.status()).rejects.toThrow("FlutterDeck's answer wasn't understood");
  });
});
