import { afterEach, describe, expect, it, vi } from 'vitest';
import { HTTP_TIMEOUT_MS, HttpError, NetworkError, createClient } from './client.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function reply(body: string, status: number) {
  return vi.fn<typeof fetch>(() => Promise.resolve(new Response(body, { status })));
}

describe('API client: failure paths', () => {
  it('gives up after 10 s and reports it as a network error (daemon hung or restarting)', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const fetchFn = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation timed out.', 'TimeoutError')),
          );
        }),
    );
    const pending = createClient(fetchFn).reload();
    expect(timeout).toHaveBeenCalledWith(HTTP_TIMEOUT_MS);
    expect(HTTP_TIMEOUT_MS).toBe(10_000);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(NetworkError);
  });

  it('keeps the 401 status when the body is not JSON, so session expiry is still detected', async () => {
    for (const body of ['', '<!doctype html><p>Login needed</p>', 'Unauthorized']) {
      const err = await createClient(reply(body, 401))
        .status()
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect(err instanceof HttpError && err.status).toBe(401);
    }
  });

  it('uses the error text from the daemon, and the status when there is none', async () => {
    const a = await createClient(reply('{"error":"No app attached"}', 409))
      .reload()
      .catch((e: unknown) => e);
    expect(a instanceof HttpError && a.message).toBe('No app attached');
    const b = await createClient(reply('{"oops":1}', 500))
      .reload()
      .catch((e: unknown) => e);
    expect(b instanceof HttpError && b.message).toBe('HTTP 500');
  });

  it('rejects a reload answer of the wrong shape instead of showing it', async () => {
    const err = await createClient(reply('{"ok":"yes"}', 200))
      .reload()
      .catch((e: unknown) => e);
    expect(err instanceof HttpError && err.message).toBe("FlutterDeck's answer wasn't understood");
  });

  it('keeps an app id with slashes or dots inside one path segment', async () => {
    const fetchFn = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('{"error":"Unknown app"}', { status: 404 })),
    );
    await createClient(fetchFn)
      .attach('../../api/logs?x=1#y')
      .catch(() => undefined);
    expect(fetchFn.mock.calls[0]?.[0]).toBe('/api/apps/..%2F..%2Fapi%2Flogs%3Fx%3D1%23y/attach');
  });

  it('never sends credentials to another origin: paths are relative and same-origin', async () => {
    const fetchFn = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('{"entries":[]}', { status: 200 })),
    );
    await createClient(fetchFn).activity();
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(typeof url === 'string' && url.startsWith('/api/')).toBe(true);
    expect(init?.credentials).toBe('same-origin');
  });
});
