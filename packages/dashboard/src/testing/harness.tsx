import type {
  ActivityEntry,
  LogEntry,
  ReloadResult,
  RunningApp,
  Status,
  WsMessage,
} from '@project-deck/core';
import { fakeApp } from '@project-deck/core/testing';
import { act, render } from '@testing-library/react';
import { vi } from 'vitest';
import type { DeckClient } from '../api/client.js';
import type { SocketLike } from '../api/connection.js';
import { DeckProvider } from '../state/DeckProvider.js';
import type { StorageLike } from '../state/storage.js';
import { createSessionGuard } from '../state/storage.js';
import type { RegexRunner } from '../search/runner.js';
import { createInlineRunner } from '../search/runner.js';
import type { TabId } from '../ui/App.js';
import { App } from '../ui/App.js';
import { DbProvider } from '../state/DbProvider.js';
import type { FakeDbClient } from './db-fake.js';
import { emptyDbClient } from './db-fake.js';

export class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  close(): void {
    this.closed = true;
  }
}

export class MemoryStorage implements StorageLike {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

export interface FakeDaemon {
  status: Status;
  logs: LogEntry[];
  activity: ActivityEntry[];
  reloadResult: ReloadResult;
}

export function fakeDaemon(overrides: Partial<FakeDaemon> = {}): FakeDaemon {
  return {
    status: {
      version: '0.1.0',
      dashboardUrl: 'http://127.0.0.1:9147/',
      projectName: 'shop_app',
      discovering: false,
      apps: [fakeApp()],
      attached: fakeApp(),
    },
    logs: [],
    activity: [],
    reloadResult: { ok: true, kind: 'hot-reload', durationMs: 182 },
    ...overrides,
  };
}

/** Renders the dashboard against an in-memory daemon and lets tests drive the socket. */
export function renderDashboard(
  daemon: FakeDaemon = fakeDaemon(),
  prefs = new MemoryStorage(),
  search: RegexRunner = createInlineRunner(),
  /** The M2 tests start on Logs; the Database tab's tests pass `database` and a fake db. */
  opts: { tab?: TabId; db?: FakeDbClient } = {},
) {
  const db = opts.db ?? emptyDbClient();
  const sockets: FakeSocket[] = [];
  const client = {
    status: vi.fn<DeckClient['status']>(() => Promise.resolve(daemon.status)),
    logs: vi.fn(() => Promise.resolve({ entries: daemon.logs, truncated: false })),
    activity: vi.fn(() => Promise.resolve({ entries: daemon.activity })),
    attach: vi.fn<DeckClient['attach']>((id) => {
      const app = daemon.status.apps.find((a) => a.id === id);
      return app === undefined ? Promise.reject(new Error('gone')) : Promise.resolve(app);
    }),
    reload: vi.fn(() => Promise.resolve(daemon.reloadResult)),
    restart: vi.fn(() =>
      Promise.resolve<ReloadResult>({ ok: true, kind: 'hot-restart', durationMs: 900 }),
    ),
    // Like the daemon: the clear is announced to every open tab over the socket.
    clearLogs: vi.fn(() => {
      const message = { type: 'logs.cleared', payload: { at: Date.now() } };
      sockets.at(-1)?.onmessage?.({ data: JSON.stringify(message) });
      return Promise.resolve();
    }),
  } satisfies DeckClient;
  const reloadPage = vi.fn();
  const session = new MemoryStorage();
  const deps = {
    client,
    openSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    guard: createSessionGuard(() => session),
    reloadPage,
    now: Date.now,
  };
  const view = render(
    <DeckProvider deps={deps}>
      <DbProvider client={db}>
        <App prefs={() => prefs} search={search} initialTab={opts.tab ?? 'logs'} />
      </DbProvider>
    </DeckProvider>,
  );
  const socket = (): FakeSocket => {
    const s = sockets.at(-1);
    if (s === undefined) throw new Error('No socket yet');
    return s;
  };
  return {
    ...view,
    client,
    db,
    reloadPage,
    sockets,
    prefs,
    session,
    socket,
    /** Opens the socket and lets the first loads finish. */
    async connect() {
      await act(async () => {
        socket().onopen?.();
        await Promise.resolve();
      });
    },
    async send(message: WsMessage) {
      await act(async () => {
        socket().onmessage?.({ data: JSON.stringify(message) });
        await Promise.resolve();
      });
    },
    async drop() {
      await act(async () => {
        socket().onclose?.();
        await Promise.resolve();
      });
    },
  };
}

export const app2: RunningApp = fakeApp({
  id: 'app-2',
  name: 'com.example.admin',
  startedBy: 'terminal',
});
