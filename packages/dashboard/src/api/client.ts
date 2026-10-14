import type {
  ActivityList,
  LogsResult,
  ReloadResult,
  RunningApp,
  Status,
} from '@project-deck/core';
import {
  ActivityListSchema,
  ErrorResponse,
  LogsResponse,
  OkResponse,
  ReloadResultSchema,
  RunningAppSchema,
  StatusResponse,
} from '@project-deck/core';
import type { z } from 'zod';

/** Design note, "Failure plan": every dashboard HTTP call gives up after 10 s. */
export const HTTP_TIMEOUT_MS = 10_000;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The daemon couldn't be reached at all (down, or the call timed out). */
export class NetworkError extends Error {}

export interface DeckClient {
  status(): Promise<Status>;
  logs(limit: number): Promise<LogsResult>;
  activity(): Promise<ActivityList>;
  attach(appId: string): Promise<RunningApp>;
  reload(): Promise<ReloadResult>;
  restart(): Promise<ReloadResult>;
  clearLogs(): Promise<void>;
}

const NOT_UNDERSTOOD = "FlutterDeck's answer wasn't understood";

export function createClient(fetchFn: typeof fetch = fetch.bind(globalThis)): DeckClient {
  async function call<S extends z.ZodType>(
    path: string,
    schema: S,
    method: 'GET' | 'POST' | 'DELETE' = 'GET',
  ): Promise<z.infer<S>> {
    let res: Response;
    try {
      res = await fetchFn(path, {
        method,
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (err) {
      throw new NetworkError(err instanceof Error ? err.message : 'Network error');
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new HttpError(res.status, NOT_UNDERSTOOD);
    }
    if (!res.ok) {
      const parsed = ErrorResponse.safeParse(body);
      throw new HttpError(res.status, parsed.success ? parsed.data.error : `HTTP ${res.status}`);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new HttpError(res.status, NOT_UNDERSTOOD);
    return parsed.data;
  }

  return {
    status: () => call('/api/status', StatusResponse),
    logs: (limit) => call(`/api/logs?limit=${limit}`, LogsResponse),
    activity: () => call('/api/activity', ActivityListSchema),
    attach: (appId) =>
      call(`/api/apps/${encodeURIComponent(appId)}/attach`, RunningAppSchema, 'POST'),
    reload: () => call('/api/reload', ReloadResultSchema, 'POST'),
    restart: () => call('/api/restart', ReloadResultSchema, 'POST'),
    clearLogs: async () => {
      await call('/api/logs', OkResponse, 'DELETE');
    },
  };
}
