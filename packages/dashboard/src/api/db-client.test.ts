import { describe, expect, it, vi } from 'vitest';
import { DbApiError, createDbClient } from './db-client.js';

function answering(status: number, body: unknown) {
  return vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
}

describe('createDbClient', () => {
  it('sends JSON to its own origin with the cookie only, never a token or a query string', async () => {
    const fetchFn = answering(200, { columns: [], rows: [], truncated: false, durationMs: 1 });
    await createDbClient(fetchFn).query({ db: 'app', sql: 'SELECT ?', params: ['secret'] });
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe('/api/db/query');
    expect(init?.credentials).toBe('same-origin');
    expect(init?.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
    });
    expect(init?.body).toBe(JSON.stringify({ db: 'app', sql: 'SELECT ?', params: ['secret'] }));
  });

  it('encodes database names in the schema path', async () => {
    const fetchFn = answering(200, { db: 'app_flutter/app.sqlite', tables: [] });
    await createDbClient(fetchFn).schema('app_flutter/app.sqlite');
    expect(fetchFn.mock.calls[0]?.[0]).toBe('/api/db/app_flutter%2Fapp.sqlite/schema');
  });

  it("keeps the daemon's code, the gate's detail and the devices to pick from", async () => {
    const devices = [{ id: 'emulator-5554', name: 'emulator-5554' }];
    const err: unknown = await createDbClient(
      answering(422, {
        error: 'Send only one statement at a time.',
        code: 'refused',
        detail: 'multiple-statements',
        devices,
      }),
    )
      .query({ db: 'app', sql: 'SELECT 1; SELECT 2' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbApiError);
    expect(err).toMatchObject({
      code: 'refused',
      message: 'Send only one statement at a time.',
      detail: 'multiple-statements',
      devices,
    });
  });

  it('says network when the daemon is unreachable, http for an answer it cannot read', async () => {
    const down = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(createDbClient(down).list()).rejects.toMatchObject({ code: 'network' });
    await expect(createDbClient(answering(200, { nope: true })).list()).rejects.toMatchObject({
      code: 'http',
    });
    await expect(createDbClient(answering(500, { error: 'boom' })).list()).rejects.toMatchObject({
      code: 'http',
      message: 'boom',
    });
  });

  it('says cancelled when the caller stopped the query', async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const pending = createDbClient(fetchFn).query(
      { db: 'app', sql: 'SELECT 1' },
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });
});
