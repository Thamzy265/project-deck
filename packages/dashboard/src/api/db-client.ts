import type {
  DbDevice,
  DbDiff,
  DbEditRequest,
  DbList,
  DbSchema,
  QueryResult,
  SavedQuery,
} from '@project-deck/core';
import {
  DbDiffResponse,
  DbEditRequestResponse,
  DbErrorResponse,
  DbExecuteResponse,
  DbListResponse,
  DbQueryResponse,
  DbSchemaResponse,
  DbSnapshotResponse,
  ErrorResponse,
  OkResponse,
  SavedQueriesSchema,
} from '@project-deck/core';
import type { z } from 'zod';
import { HTTP_TIMEOUT_MS } from './client.js';

/**
 * A failed `/api/db` call. `code` is the daemon's DbError code, `network` when the
 * daemon couldn't be reached, or `http` for an answer without one.
 */
export class DbApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: string,
    readonly devices?: DbDevice[],
  ) {
    super(message);
  }
}

export type Param = string | number | boolean | null | { type: 'int'; value: string };

export interface DbClient {
  list(): Promise<DbList>;
  schema(db: string): Promise<DbSchema>;
  query(
    input: { db: string; sql: string; params?: Param[]; limit?: number },
    signal?: AbortSignal,
  ): Promise<QueryResult>;
  snapshot(db: string): Promise<{ id: string; takenAt: number }>;
  diff(db: string, snapshotId: string): Promise<DbDiff>;
  refresh(db: string): Promise<void>;
  requestEdit(input: { db: string; sql: string; params: Param[] }): Promise<DbEditRequest>;
  confirmEdit(input: { requestId: string; sql: string; params: Param[] }): Promise<{
    changes: number;
  }>;
  cancelEdit(requestId: string): Promise<void>;
  chooseDevice(source: string, device: string): Promise<DbList>;
  savedQueries(): Promise<SavedQuery[]>;
  saveQueries(queries: SavedQuery[]): Promise<SavedQuery[]>;
}

const NOT_UNDERSTOOD = "FlutterDeck's answer wasn't understood";

/** Same origin and the login cookie only; nothing secret ever goes in a URL. */
export function createDbClient(fetchFn: typeof fetch = fetch.bind(globalThis)): DbClient {
  async function call<S extends z.ZodType>(
    path: string,
    schema: S,
    method: 'GET' | 'POST' | 'PUT',
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<z.infer<S>> {
    const timeout = AbortSignal.timeout(HTTP_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchFn(path, {
        method,
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      });
    } catch (err) {
      if (signal?.aborted === true) throw new DbApiError('cancelled', 'Cancelled');
      throw new DbApiError('network', err instanceof Error ? err.message : 'Network error');
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new DbApiError('http', NOT_UNDERSTOOD);
    }
    if (!res.ok) {
      const db = DbErrorResponse.safeParse(json);
      if (db.success) {
        throw new DbApiError(db.data.code, db.data.error, db.data.detail, db.data.devices);
      }
      const plain = ErrorResponse.safeParse(json);
      throw new DbApiError('http', plain.success ? plain.data.error : `HTTP ${res.status}`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new DbApiError('http', NOT_UNDERSTOOD);
    return parsed.data;
  }

  return {
    list: () => call('/api/db', DbListResponse, 'GET'),
    schema: (db) => call(`/api/db/${encodeURIComponent(db)}/schema`, DbSchemaResponse, 'GET'),
    query: (input, signal) => call('/api/db/query', DbQueryResponse, 'POST', input, signal),
    snapshot: (db) => call('/api/db/snapshot', DbSnapshotResponse, 'POST', { db }),
    diff: (db, snapshotId) => call('/api/db/diff', DbDiffResponse, 'POST', { db, snapshotId }),
    refresh: async (db) => {
      await call('/api/db/refresh', OkResponse, 'POST', { db });
    },
    requestEdit: (input) => call('/api/db/execute', DbEditRequestResponse, 'POST', input),
    confirmEdit: (input) => call('/api/db/execute/confirm', DbExecuteResponse, 'POST', input),
    cancelEdit: async (requestId) => {
      await call('/api/db/execute/cancel', OkResponse, 'POST', { requestId });
    },
    chooseDevice: (source, device) =>
      call('/api/db/device', DbListResponse, 'POST', { source, device }),
    savedQueries: async () => (await call('/api/db/queries', SavedQueriesSchema, 'GET')).queries,
    saveQueries: async (queries) =>
      (await call('/api/db/queries', SavedQueriesSchema, 'PUT', { queries })).queries,
  };
}

export function asDbApiError(err: unknown): DbApiError {
  if (err instanceof DbApiError) return err;
  return new DbApiError('http', err instanceof Error ? err.message : 'Unknown error');
}
