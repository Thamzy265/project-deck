/**
 * `/api/db/*`. These routes sit behind the API's Host, Origin and token checks like
 * every other `/api` route. On top of that, edits accept only the dashboard cookie with
 * the dashboard's exact Origin, never the runtime.json token (design review S1).
 */
import type { DbErrorCode } from '@project-deck/core';
import {
  DbDiffInput,
  DbEditCancelInput,
  DbEditConfirmInput,
  DbExecuteInput,
  DbQueryInput,
  DbRefreshInput,
  DbSchemaInput,
  DbSnapshotInput,
  McpDbQueryInput,
  isDbError,
} from '@project-deck/core';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { DbCaller, DbService } from './db-service.js';
import { jsonBody, parse } from './http-input.js';
import type { Credentials } from './security.js';
import { authenticate } from './security.js';

/** SQL (100 kB) plus up to 1,000 parameters, with room to spare. */
export const DB_BODY_LIMIT = 512 * 1024;

const STATUS: Record<DbErrorCode, ContentfulStatusCode> = {
  'not-found': 404,
  unsupported: 422,
  timeout: 504,
  busy: 503,
  'too-large': 413,
  refused: 422,
  'sql-error': 422,
  'bad-token': 409,
  'not-allowed': 403,
  'setup-needed': 409,
  'update-needed': 409,
  'app-gone': 409,
  'not-debuggable': 403,
  unavailable: 503,
  'choose-device': 409,
  internal: 500,
};

/** A DbError as `{error, code}` with its status; undefined for other errors. */
export function dbErrorResponse(c: Context, err: unknown): Response | undefined {
  if (!isDbError(err)) return undefined;
  return c.json({ error: err.message, code: err.code }, STATUS[err.code]);
}

export interface DbRouteContext {
  db: DbService;
  credentials: () => Credentials;
}

export function registerDbRoutes<E extends object>(api: Hono<E>, ctx: DbRouteContext): void {
  const limit = bodyLimit({
    maxSize: DB_BODY_LIMIT,
    onError: (c) => c.json({ error: 'Body too large' }, 413),
  });
  const caller = (c: Context): DbCaller =>
    authenticate((n) => c.req.header(n), ctx.credentials()) === 'cookie' ? 'dashboard' : 'claude';

  /** Edits: the dashboard cookie and its own exact Origin only, never the token. */
  const dashboardOnly = (c: Context): Response | undefined => {
    const creds = ctx.credentials();
    const origin = c.req.header('origin');
    const own = [`http://127.0.0.1:${creds.port}`, `http://localhost:${creds.port}`];
    if (
      authenticate((n) => c.req.header(n), creds) !== 'cookie' ||
      origin === undefined ||
      !own.includes(origin)
    ) {
      return c.json(
        { error: 'Changes are made only in the dashboard, with a confirm.', code: 'not-allowed' },
        403,
      );
    }
    return undefined;
  };

  api.get('/api/db', async (c) => c.json(await ctx.db.list()));

  api.get('/api/db/:db/schema', async (c) => {
    const { db } = parse(DbSchemaInput, { db: c.req.param('db') });
    return c.json(await ctx.db.schema(db));
  });

  api.post('/api/db/query', limit, async (c) => {
    const who = caller(c);
    const input = parse(
      who === 'dashboard' ? DbQueryInput : McpDbQueryInput,
      await jsonBody(c.req),
    );
    return c.json(await ctx.db.query(input, who));
  });

  api.post('/api/db/snapshot', limit, async (c) =>
    c.json(await ctx.db.snapshot(parse(DbSnapshotInput, await jsonBody(c.req)))),
  );

  api.post('/api/db/diff', limit, async (c) =>
    c.json(await ctx.db.diff(parse(DbDiffInput, await jsonBody(c.req)), caller(c))),
  );

  api.post('/api/db/refresh', limit, async (c) => {
    await ctx.db.refresh(parse(DbRefreshInput, await jsonBody(c.req)).db);
    return c.json({ ok: true });
  });

  api.post('/api/db/execute', limit, async (c) => {
    const refused = dashboardOnly(c);
    if (refused !== undefined) return refused;
    return c.json(await ctx.db.requestEdit(parse(DbExecuteInput, await jsonBody(c.req))));
  });

  api.post('/api/db/execute/confirm', limit, async (c) => {
    const refused = dashboardOnly(c);
    if (refused !== undefined) return refused;
    return c.json(await ctx.db.confirmEdit(parse(DbEditConfirmInput, await jsonBody(c.req))));
  });

  api.post('/api/db/execute/cancel', limit, async (c) => {
    const refused = dashboardOnly(c);
    if (refused !== undefined) return refused;
    ctx.db.cancelEdit(parse(DbEditCancelInput, await jsonBody(c.req)).requestId);
    return c.json({ ok: true });
  });
}
