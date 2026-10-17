import type {
  EventBus,
  Health,
  LogEntry,
  LogQuery,
  LoginWindowResult,
  Status,
} from '@project-deck/core';
import {
  DEFAULT_LOG_LIMIT,
  GetLogsInput,
  HookEventInput,
  regexHaystacks,
} from '@project-deck/core';
import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { DbRouteContext } from './db-routes.js';
import { dbErrorResponse, registerDbRoutes } from './db-routes.js';
import type { DbService } from './db-service.js';
import { BadRequest, jsonBody, parse } from './http-input.js';
import type { ActivityFeed } from './activity.js';
import type { DashboardAsset, DashboardAssets } from './dashboard-assets.js';
import type { AppManager } from './app-manager.js';
import type { LoginWindow } from './login-window.js';
import { DEFAULT_CSP, LOGIN_NEEDED_PAGE, LOGIN_PAGE_CSP } from './login-page.js';
import { UnknownAppError } from './app-manager.js';
import { REGEX_FAILED, REGEX_TOO_SLOW, RegexFilter } from './regex-filter.js';
import {
  authenticate,
  cookieValues,
  isAllowedHost,
  isAllowedOrigin,
  isTopLevelNavigation,
  sessionCookie,
  sessionCookieName,
  tokensEqual,
} from './security.js';

export interface ApiContext {
  manager: AppManager;
  bus: EventBus;
  activity: Pick<ActivityFeed, 'list'>;
  token: string;
  /** Random per daemon start; the dashboard cookie holds it. Never the token. */
  sessionSecret: string;
  /** When `GET /` may hand out the cookie (ADR 0003). */
  loginWindow: LoginWindow;
  /** Read lazily: the port is only known once the server is listening. */
  port: () => number;
  version: string;
  /** Lets clients tell this project's daemon from another project's on the same port. */
  /** Omitted from /api/health when unknown. */
  projectId: string | undefined;
  /** The project folder's name, shown in the dashboard header. */
  projectName: string;
  /** The built dashboard; a placeholder page is served without it. */
  dashboard?: DashboardAssets | undefined;
  /** Stops the daemon after the response is sent. */
  shutdown: () => void;
  /** Runs `regex` log filters off the main thread; one is made if not given. */
  regexFilter?: RegexFilter | undefined;
  /** The database layer; without it the `/api/db` routes don't exist. */
  db?: DbService | undefined;
  /** The SQL editor's saved queries (`.flutterdeck/queries.json`). */
  queries?: DbRouteContext['queries'] | undefined;
}

/**
 * Largest `POST /api/events` body. A real hook event is under 3 kB (a 2000-character
 * waiting message at most), so anything bigger is refused before it is read as JSON.
 */
export const EVENTS_BODY_LIMIT = 16 * 1024;

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
  'X-Frame-Options': 'DENY',
};

function asset(c: Context, file: DashboardAsset): Response {
  return c.body(file.body, 200, { 'Content-Type': file.type });
}

function setSecurityHeaders(headers: Headers, path: string, csp: string): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  headers.set('Content-Security-Policy', csp);
  // API answers hold logs and app state; a page that sets the login cookie mustn't be cached.
  if (path === '/' || path.startsWith('/api/')) headers.set('Cache-Control', 'no-store');
}

/** `csp` lets one route (the Login needed page) name its own policy. */
type DeckEnv = { Variables: { csp: string | undefined } };

export function createApi(ctx: ApiContext): Hono<DeckEnv> {
  const api = new Hono<DeckEnv>();
  const regexFilter = ctx.regexFilter ?? new RegexFilter();

  // First, so error responses from later checks get the headers too.
  api.use('*', async (c, next) => {
    await next();
    setSecurityHeaders(c.res.headers, c.req.path, c.get('csp') ?? DEFAULT_CSP);
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
    c.json<Health>({
      ok: true,
      name: 'project-deck',
      version: ctx.version,
      ...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
    }),
  );

  const page = ctx.dashboard?.get('/');
  const dashboardPage = (c: Context) =>
    page === undefined ? c.html(PLACEHOLDER_PAGE) : asset(c, page);

  // The dashboard's login: a tab opened on / gets the session cookie (ADR 0001, 0003).
  api.get('/', (c) => {
    const header = (n: string) => c.req.header(n);
    const cookie = cookieValues(header('cookie'), sessionCookieName(ctx.port()));
    if (cookie.some((value) => tokensEqual(value, ctx.sessionSecret))) return dashboardPage(c);
    if (!ctx.loginWindow.isOpen()) {
      c.set('csp', LOGIN_PAGE_CSP);
      return c.html(LOGIN_NEEDED_PAGE);
    }
    if (isTopLevelNavigation(header)) {
      c.header('Set-Cookie', sessionCookie(ctx.port(), ctx.sessionSecret));
    }
    return dashboardPage(c);
  });

  const requireAuth: MiddlewareHandler = async (c, next) => {
    const creds = { token: ctx.token, sessionSecret: ctx.sessionSecret, port: ctx.port() };
    if (authenticate((n) => c.req.header(n), creds) === undefined) {
      return c.json({ error: 'Missing or invalid token' }, 401);
    }
    await next();
  };
  api.use('/api/*', requireAuth);
  api.use('/assets/*', requireAuth);

  // Only the exact files the build produced: no SPA fallback, no file system lookups.
  api.get('/assets/*', (c) => {
    const file = ctx.dashboard?.get(c.req.path);
    return file === undefined ? c.json({ error: 'Not found' }, 404) : asset(c, file);
  });

  // Only the runtime.json token may open the window: a cookie holder (possibly another
  // OS user who got in during an earlier window) must not extend it.
  api.post('/api/login-window', (c) => {
    const creds = { token: ctx.token, sessionSecret: ctx.sessionSecret, port: ctx.port() };
    if (authenticate((n) => c.req.header(n), creds) !== 'token') {
      return c.json({ error: 'Opening the login window needs the runtime.json token' }, 403);
    }
    const body: LoginWindowResult = { ok: true, until: ctx.loginWindow.open() };
    return c.json(body);
  });

  api.get('/api/status', (c) =>
    c.json<Status>({
      version: ctx.version,
      dashboardUrl: `http://127.0.0.1:${ctx.port()}/`,
      projectName: ctx.projectName,
      discovering: ctx.manager.discovering(),
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
    const { regex, ...q } = logQueryFromSearch(c.req.query());
    const limit = q.limit ?? DEFAULT_LOG_LIMIT;
    let entries: LogEntry[];
    if (regex === undefined) {
      // Ask for one extra so we can tell the caller the result was cut short.
      entries = await logs.query({ ...q, limit: limit + 1 });
    } else {
      // The other filters here, the regex in a worker with a time budget.
      const candidates = await logs.query({ ...q, limit: Number.MAX_SAFE_INTEGER });
      // Message and stack are tested separately; owner[i] is the entry text i belongs to.
      const owner: number[] = [];
      const texts = candidates.flatMap((e, i) =>
        regexHaystacks(e).map((t) => {
          owner.push(i);
          return t;
        }),
      );
      const result = await regexFilter.match(regex, texts);
      if (!result.ok) {
        return result.reason === 'slow'
          ? c.json({ error: REGEX_TOO_SLOW }, 400)
          : c.json({ error: REGEX_FAILED }, 503);
      }
      const hit = new Set(owner.filter((_, t) => result.matches[t] === true));
      entries = candidates.filter((_, i) => hit.has(i)).slice(-(limit + 1));
    }
    const truncated = entries.length > limit;
    return c.json({ entries: truncated ? entries.slice(1) : entries, truncated });
  });

  api.get('/api/activity', (c) => c.json({ entries: ctx.activity.list() }));

  api.delete('/api/logs', (c) => {
    ctx.manager.logs()?.clear();
    // Other open tabs must drop the lines too: the Clear button is the delete path.
    ctx.bus.emit('logs.cleared', { at: Date.now() });
    return c.json({ ok: true });
  });

  const eventsBodyLimit = bodyLimit({
    maxSize: EVENTS_BODY_LIMIT,
    onError: (c) => c.json({ error: 'Body too large' }, 413),
  });

  api.post('/api/events', eventsBodyLimit, async (c) => {
    const event = parse(HookEventInput, await jsonBody(c.req));
    if (event.type === 'claude.done') {
      ctx.bus.emit(
        'claude.done',
        event.sessionId === undefined ? {} : { sessionId: event.sessionId },
      );
    } else if (event.type === 'claude.waiting') {
      ctx.bus.emit('claude.waiting', {
        ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
        ...(event.message === undefined ? {} : { message: event.message }),
      });
    } else {
      ctx.bus.emit('claude.reload', {
        ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
        ok: event.ok,
        kind: event.kind,
        ...(event.message === undefined ? {} : { message: event.message }),
      });
    }
    return c.json({ ok: true });
  });

  api.post('/api/shutdown', (c) => {
    setImmediate(ctx.shutdown);
    return c.json({ ok: true });
  });

  if (ctx.db !== undefined) {
    registerDbRoutes(api, {
      db: ctx.db,
      credentials: () => ({ token: ctx.token, sessionSecret: ctx.sessionSecret, port: ctx.port() }),
      ...(ctx.queries === undefined ? {} : { queries: ctx.queries }),
    });
  }

  api.notFound((c) => c.json({ error: 'Not found' }, 404));

  api.onError((err, c) => {
    if (err instanceof BadRequest) return c.json({ error: err.message, issues: err.issues }, 400);
    const dbError = dbErrorResponse(c, err);
    if (dbError !== undefined) return dbError;
    if (err instanceof UnknownAppError) return c.json({ error: err.message }, 404);
    return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  });

  return api;
}
