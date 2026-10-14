import type { ActivityEntry, LogEntry, ReloadResult, RunningApp, Status } from '@project-deck/core';
import { ACTIVITY_CAPACITY, DEFAULT_LOG_CAPACITY } from '@project-deck/core';
import type { ConnectionState } from '../api/connection.js';
import type { LogList } from './logs.js';
import { appendLogs, mergeBackfill } from './logs.js';

export type ActionKind = 'reload' | 'restart';

/** What the result chip shows about the newest reload or restart, whoever made it. */
export interface LastResult {
  ok: boolean;
  kind: ActionKind;
  /** Made by Claude or the IDE, seen through the VM service. */
  external: boolean;
  durationMs?: number;
  message?: string;
  /** When it started (ours) or was seen (others); "since last reload" counts from here. */
  startedAt: number;
}

/** Entries the page adds itself; the daemon's entries come from its feed. */
export interface LocalActivity {
  kind: 'local';
  id: string;
  ts: number;
  text: 'Reconnected' | 'Logs cleared';
}
export type ActivityItem = ActivityEntry | LocalActivity;

type Loadable = { status: 'loading' } | { status: 'ready' } | { status: 'error'; error: string };

export interface DeckState {
  connection: ConnectionState;
  /** Set once the first status answer arrived. */
  info: { version: string; projectName: string } | undefined;
  apps: RunningApp[];
  /** The daemon is still starting its connectors; no apps yet isn't final. */
  discovering: boolean;
  attached: RunningApp | null;
  /** The last attached app, kept to show it greyed out when offline or stopped. */
  lastApp: RunningApp | null;
  stoppedApp: RunningApp | null;
  attach:
    | { status: 'idle' }
    | { status: 'running'; appId: string }
    | { status: 'error'; error: string; appId: string };
  logs: LogList & { load: Loadable };
  /**
   * When the logs were last cleared (epoch ms). A backfill already on its way must not
   * bring older lines back.
   */
  logsClearedAt: number | undefined;
  activity: { items: ActivityItem[]; load: Loadable; nextLocal: number };
  /** `matched`: the daemon's app.reloaded for it has already arrived. */
  running: { kind: ActionKind; startedAt: number; matched: boolean } | null;
  /**
   * Our last finished action whose app.reloaded event hasn't arrived yet (the HTTP answer
   * came first). The event, when it comes, belongs to it, not to a new reload.
   */
  lastOwn: { kind: ActionKind; startedAt: number; finishedAt: number } | null;
  lastResult: LastResult | null;
  /** Apps whose reload answered `unsupported`; the buttons are hidden for them. */
  unsupported: string[];
  clearError: boolean;
}

export const initialState: DeckState = {
  connection: { kind: 'connecting' },
  info: undefined,
  apps: [],
  discovering: true,
  attached: null,
  lastApp: null,
  stoppedApp: null,
  attach: { status: 'idle' },
  logs: { entries: [], nextKey: 0, load: { status: 'loading' } },
  logsClearedAt: undefined,
  activity: { items: [], load: { status: 'loading' }, nextLocal: 0 },
  running: null,
  lastOwn: null,
  lastResult: null,
  unsupported: [],
  clearError: false,
};

export type DeckAction =
  | { type: 'connection'; state: ConnectionState }
  | { type: 'status'; status: Status }
  | { type: 'apps'; apps: RunningApp[]; attached?: RunningApp | null; discovering?: boolean }
  | { type: 'discovering'; discovering: boolean }
  | { type: 'attached'; app: RunningApp }
  | { type: 'detached'; appId: string }
  | { type: 'exited'; appId: string }
  | { type: 'reloaded'; result: ReloadResult; at: number }
  | { type: 'action-start'; kind: ActionKind; at: number }
  | { type: 'action-done'; result: ReloadResult; at: number }
  | { type: 'action-failed'; message: string; at: number }
  | { type: 'attach-start'; appId: string }
  | { type: 'attach-failed'; appId: string; error: string }
  | { type: 'logs-loading' }
  | { type: 'logs-loaded'; entries: LogEntry[]; merge: boolean }
  | { type: 'logs-failed'; error: string }
  | { type: 'logs-append'; entries: LogEntry[] }
  /** `announce`: from the daemon's event, so Activity notes it once in every tab. */
  | { type: 'logs-cleared'; at: number; announce: boolean }
  | { type: 'clear-failed' }
  | { type: 'activity-loading' }
  | { type: 'activity-loaded'; entries: ActivityEntry[] }
  | { type: 'activity-failed'; error: string }
  | { type: 'activity-add'; entry: ActivityEntry }
  | { type: 'activity-local'; text: LocalActivity['text']; at: number };

const LOG_CAP = DEFAULT_LOG_CAPACITY;

/**
 * Oldest first and at most as many as the daemon keeps (500), so the list stays sorted
 * here once instead of on every render.
 */
function timeline(items: ActivityItem[]): ActivityItem[] {
  const sorted = items.sort((a, b) => a.ts - b.ts);
  return sorted.length > ACTIVITY_CAPACITY ? sorted.slice(-ACTIVITY_CAPACITY) : sorted;
}

function withAttached(state: DeckState, attached: RunningApp | null): DeckState {
  if (attached === null) return { ...state, attached };
  // An app is attached now, so an earlier "Couldn't attach" no longer applies.
  return { ...state, attached, lastApp: attached, stoppedApp: null, attach: { status: 'idle' } };
}

function resultFrom(result: ReloadResult, kind: ActionKind, startedAt: number): LastResult {
  if (result.ok) {
    return {
      ok: true,
      kind: result.kind === 'hot-restart' ? 'restart' : 'reload',
      external: result.source === 'external',
      ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
      startedAt,
    };
  }
  return {
    ok: false,
    kind,
    external: result.source === 'external',
    message: result.message,
    startedAt,
  };
}

function markUnsupported(state: DeckState, result: ReloadResult): string[] {
  const id = state.attached?.id;
  if (result.ok || result.reason !== 'unsupported' || id === undefined) return state.unsupported;
  return state.unsupported.includes(id) ? state.unsupported : [...state.unsupported, id];
}

/** How long after our action's HTTP answer its app.reloaded event may still arrive. */
export const OWN_EVENT_WINDOW_MS = 2000;

/** Our own reload answers twice (HTTP and the socket); label both as the same action. */
function reloaded(state: DeckState, result: ReloadResult, at: number): DeckState {
  const unsupported = markUnsupported(state, result);
  if (result.source !== 'external') {
    const run = state.running;
    if (run !== null) {
      return {
        ...state,
        running: { ...run, matched: true },
        lastResult: resultFrom(result, run.kind, run.startedAt),
        unsupported,
      };
    }
    const own = state.lastOwn;
    if (own !== null && at - own.finishedAt <= OWN_EVENT_WINDOW_MS) {
      return {
        ...state,
        lastOwn: null,
        lastResult: resultFrom(result, own.kind, own.startedAt),
        unsupported,
      };
    }
  }
  return { ...state, lastResult: resultFrom(result, 'reload', at), unsupported };
}

export function deckReducer(state: DeckState, action: DeckAction): DeckState {
  switch (action.type) {
    case 'connection':
      return { ...state, connection: action.state };
    case 'status':
      return withAttached(
        {
          ...state,
          info: { version: action.status.version, projectName: action.status.projectName },
          apps: action.status.apps,
          discovering: action.status.discovering,
        },
        action.status.attached,
      );
    case 'discovering':
      return { ...state, discovering: action.discovering };
    case 'apps': {
      const next = {
        ...state,
        apps: action.apps,
        discovering: action.discovering ?? state.discovering,
      };
      return action.attached === undefined ? next : withAttached(next, action.attached);
    }
    case 'attached':
      return withAttached(state, action.app);
    case 'detached':
      return state.attached?.id === action.appId ? { ...state, attached: null } : state;
    case 'exited':
      if (state.attached?.id !== action.appId) return state;
      return { ...state, attached: null, stoppedApp: state.attached, running: null };
    case 'reloaded':
      return reloaded(state, action.result, action.at);
    case 'action-start':
      return {
        ...state,
        running: { kind: action.kind, startedAt: action.at, matched: false },
        lastOwn: null,
      };
    case 'action-done': {
      const run = state.running;
      if (run === null) return state;
      return {
        ...state,
        running: null,
        lastOwn: run.matched ? null : { ...run, finishedAt: action.at },
        lastResult: resultFrom(action.result, run.kind, run.startedAt),
        unsupported: markUnsupported(state, action.result),
      };
    }
    case 'action-failed': {
      if (state.running === null) return state;
      const { kind, startedAt } = state.running;
      return {
        ...state,
        running: null,
        lastResult: { ok: false, kind, external: false, message: action.message, startedAt },
      };
    }
    case 'attach-start':
      return { ...state, attach: { status: 'running', appId: action.appId } };
    case 'attach-failed':
      return { ...state, attach: { status: 'error', appId: action.appId, error: action.error } };
    case 'logs-loading':
      return { ...state, logs: { ...state.logs, load: { status: 'loading' } } };
    case 'logs-loaded': {
      const after = state.logsClearedAt;
      const entries =
        after === undefined ? action.entries : action.entries.filter((e) => e.ts >= after);
      const list = action.merge
        ? mergeBackfill(state.logs, entries, LOG_CAP)
        : appendLogs({ entries: [], nextKey: state.logs.nextKey }, entries, LOG_CAP);
      return { ...state, logs: { ...list, load: { status: 'ready' } } };
    }
    case 'logs-failed':
      return { ...state, logs: { ...state.logs, load: { status: 'error', error: action.error } } };
    case 'logs-append':
      return {
        ...state,
        logs: { ...appendLogs(state.logs, action.entries, LOG_CAP), load: state.logs.load },
      };
    case 'logs-cleared': {
      const cleared: DeckState = {
        ...state,
        clearError: false,
        logs: { entries: [], nextKey: state.logs.nextKey, load: state.logs.load },
        logsClearedAt: Math.max(state.logsClearedAt ?? action.at, action.at),
      };
      return action.announce
        ? deckReducer(cleared, { type: 'activity-local', text: 'Logs cleared', at: action.at })
        : cleared;
    }
    case 'clear-failed':
      return { ...state, clearError: true };
    case 'activity-loading':
      return { ...state, activity: { ...state.activity, load: { status: 'loading' } } };
    case 'activity-loaded': {
      const ids = new Set(action.entries.map((e) => e.id));
      const kept = state.activity.items.filter((i) => i.kind === 'local' || !ids.has(i.id));
      return {
        ...state,
        activity: {
          ...state.activity,
          items: timeline([...kept, ...action.entries]),
          load: { status: 'ready' },
        },
      };
    }
    case 'activity-failed':
      return {
        ...state,
        activity: { ...state.activity, load: { status: 'error', error: action.error } },
      };
    case 'activity-add': {
      const exists = state.activity.items.some(
        (i) => i.kind !== 'local' && i.id === action.entry.id,
      );
      if (exists) return state;
      return {
        ...state,
        activity: { ...state.activity, items: timeline([...state.activity.items, action.entry]) },
      };
    }
    case 'activity-local': {
      const item: LocalActivity = {
        kind: 'local',
        id: `local-${String(state.activity.nextLocal)}`,
        ts: action.at,
        text: action.text,
      };
      return {
        ...state,
        activity: {
          ...state.activity,
          items: timeline([...state.activity.items, item]),
          nextLocal: state.activity.nextLocal + 1,
        },
      };
    }
  }
}
