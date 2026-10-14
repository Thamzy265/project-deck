import type { EventBus, LogQuery } from '@project-deck/core';
import { DEFAULT_LOG_LIMIT, GetLogsInput, HookEventInput } from '@project-deck/core';
import { Hono } from 'hono';
import type { z } from 'zod';
import type { AppManager } from './app-manager.js';
import { UnknownAppError } from './app-manager.js';
import {
  authenticate,
  isAllowedHost,
  isAllowedOrigin,
  isTopLevelNavigation,
  sessionCookie,
} from './security.js';

export interface ApiContext {
  manager: AppManager;
  bus: EventBus;
  token: string;
  /** Random per daemon start; the dashboard cookie holds it. Never the token. */
  sessionSecret: string;
  /** Read lazily: the port is only known once the server is listening. */
  port: () => number;
  version: string;
  /** Lets clients tell this project's daemon from another project's on the same port. */
  projectId: string;
  /** Stops the daemon after the response is sent. */
  shutdown: () => void;
}

class BadRequest extends Error {
  constructor(
    message: string,
    readonly issues?: unknown,
  ) {
    super(message);
  }
}

function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) throw new BadRequest('Invalid request', result.error.issues);
  return result.data;
}

async function jsonBody(req: { json: () => Promise<unknown> }): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new BadRequest('Body must be JSON');
  }
}

const NUMERIC_LOG_PARAMS = new Set(['since', 'limit']);

function logQueryFromSearch(params: Record<string, string>): LogQuery {
  const raw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    raw[key] = NUMERIC_LOG_PARAMS.has(key) ? Number(value) : value;
  }
  return parse(GetLogsInput, raw);
}

const PLACEHOLDER_PAGE =
  '<!doctype html><html lang="en"><meta charset="utf-8"><title>FlutterDeck</title>' +
  '<p>FlutterDeck is running.</p></html>';

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
};

function setSecurityHeaders(headers: Headers, path: string): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  // API answers hold logs and app state; a page that sets the login cookie mustn't be cached.
  if (path === '/' || path.startsWith('/api/')) headers.set('Cache-Control', 'no-store');
}

export function createApi(ctx: ApiContext): Hono {
  const api = new Hono();

  // First, so error responses from later checks get the headers too.
  api.use('*', async (c, next) => {
    await next();
    setSecurityHeaders(c.res.headers, c.req.path);
  });

  api.use('*', async (c, next) => {
    const port = ctx.port();
    if (!isAllowedHost(c.req.header('host'), port)) return c.json({ error: 'Forbidden host' }, 403);
    if (!isAllowedOrigin(c.req.header('origin'), port)) {
      return c.json({ error: 'Forbidden origin' }, 403);
    }
    await next();
  });

  // Unauthenticated so the CLI can tell "not running" from "wrong token". Reveals nothing else.
  api.get('/api/health', (c) =>
    c.json({ ok: true, name: 'project-deck', version: ctx.version, projectId: ctx.projectId }),
  );

  // The dashboard's login: a tab opened on / gets the session cookie. Placeholder page
  // until the dashboard app is served here.
  api.get('/', (c) => {
    if (isTopLevelNavigation((n) => c.req.header(n))) {
      c.header('Set-Cookie', sessionCookie(ctx.port(), ctx.sessionSecret));
    }
    return c.html(PLACEHOLDER_PAGE);
  });

  api.use('/api/*', async (c, next) => {
    const creds = { token: ctx.token, sessionSecret: ctx.sessionSecret, port: ctx.port() };
    if (authenticate((n) => c.req.header(n), creds) === undefined) {
      return c.json({ error: 'Missing or invalid token' }, 401);
    }
    await next();
  });

  api.get('/api/status', (c) =>
    c.json({
      version: ctx.version,
      dashboardUrl: `http://127.0.0.1:${ctx.port()}/`,
      apps: ctx.manager.apps(),
      attached: ctx.manager.attachedApp() ?? null,
    }),
  );

  api.get('/api/apps', (c) => c.json(ctx.manager.apps()));

  api.post('/api/apps/:id/attach', async (c) =>
    c.json(await ctx.manager.attach(c.req.param('id'))),
  );

  api.post('/api/detach', async (c) => {
    await ctx.manager.detach();
    return c.json({ ok: true });
  });

  api.post('/api/reload', async (c) => c.json(await ctx.manager.reload()));
  api.post('/api/restart', async (c) => c.json(await ctx.manager.restart()));

  api.get('/api/logs', async (c) => {
    const logs = ctx.manager.logs();
    if (logs === undefined) return c.json({ entries: [], truncated: false });
    const q = logQueryFromSearch(c.req.query());
    const limit = q.limit ?? DEFAULT_LOG_LIMIT;
    // Ask for one extra so we can tell the caller the result was cut short.
    const entries = await logs.query({ ...q, limit: limit + 1 });
    const truncated = entries.length > limit;
    return c.json({ entries: truncated ? entries.slice(1) : entries, truncated });
  });

  api.delete('/api/logs', (c) => {
    ctx.manager.logs()?.clear();
    return c.json({ ok: true });
  });

  api.post('/api/events', async (c) => {
    const event = parse(HookEventInput, await jsonBody(c.req));
    if (event.type === 'claude.done') {
      ctx.bus.emit(
        'claude.done',
        event.sessionId === undefined ? {} : { sessionId: event.sessionId },
      );
    } else {
      ctx.bus.emit('claude.waiting', {
        ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
        ...(event.message === undefined ? {} : { message: event.message }),
      });
    }
    return c.json({ ok: true });
  });

  api.post('/api/shutdown', (c) => {
    setImmediate(ctx.shutdown);
    return c.json({ ok: true });
  });

  api.notFound((c) => c.json({ error: 'Not found' }, 404));

  api.onError((err, c) => {
    if (err instanceof BadRequest) return c.json({ error: err.message, issues: err.issues }, 400);
    if (err instanceof UnknownAppError) return c.json({ error: err.message }, 404);
    return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  });

  return api;
}
