import type { ActivityEntry, LogEntry, ReloadResult, RunningApp, Status } from '@project-deck/core';
import { DEFAULT_LOG_CAPACITY } from '@project-deck/core';
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
  activity: { items: ActivityItem[]; load: Loadable };
  running: { kind: ActionKind; startedAt: number } | null;
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
  activity: { items: [], load: { status: 'loading' } },
  running: null,
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
  | { type: 'action-done'; result: ReloadResult }
  | { type: 'action-failed'; message: string }
  | { type: 'attach-start'; appId: string }
  | { type: 'attach-failed'; appId: string; error: string }
  | { type: 'logs-loading' }
  | { type: 'logs-loaded'; entries: LogEntry[]; merge: boolean }
  | { type: 'logs-failed'; error: string }
  | { type: 'logs-append'; entries: LogEntry[] }
  | { type: 'logs-cleared'; at: number }
  | { type: 'clear-failed' }
  | { type: 'activity-loading' }
  | { type: 'activity-loaded'; entries: ActivityEntry[] }
  | { type: 'activity-failed'; error: string }
  | { type: 'activity-add'; entry: ActivityEntry }
  | { type: 'activity-local'; text: LocalActivity['text']; at: number };

const LOG_CAP = DEFAULT_LOG_CAPACITY;

function withAttached(state: DeckState, attached: RunningApp | null): DeckState {
  if (attached === null) return { ...state, attached };
  const attach = state.attach.status === 'running' ? { status: 'idle' as const } : state.attach;
  return { ...state, attached, lastApp: attached, stoppedApp: null, attach };
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
    case 'reloaded': {
      // Our own reload answers through the HTTP call too; keep its start time.
      const ours = state.running !== null && action.result.source !== 'external';
      const startedAt = ours && state.running !== null ? state.running.startedAt : action.at;
      const kind = state.running?.kind ?? 'reload';
      return {
        ...state,
        lastResult: resultFrom(action.result, kind, startedAt),
        unsupported: markUnsupported(state, action.result),
      };
    }
    case 'action-start':
      return { ...state, running: { kind: action.kind, startedAt: action.at } };
    case 'action-done': {
      if (state.running === null) return state;
      return {
        ...state,
        running: null,
        lastResult: resultFrom(action.result, state.running.kind, state.running.startedAt),
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
      const list = action.merge
        ? mergeBackfill(state.logs, action.entries, LOG_CAP)
        : appendLogs({ entries: [], nextKey: state.logs.nextKey }, action.entries, LOG_CAP);
      return { ...state, logs: { ...list, load: { status: 'ready' } } };
    }
    case 'logs-failed':
      return { ...state, logs: { ...state.logs, load: { status: 'error', error: action.error } } };
    case 'logs-append':
      return {
        ...state,
        logs: { ...appendLogs(state.logs, action.entries, LOG_CAP), load: state.logs.load },
      };
    case 'logs-cleared':
      return deckReducer(
        {
          ...state,
          clearError: false,
          logs: { entries: [], nextKey: state.logs.nextKey, load: state.logs.load },
        },
        { type: 'activity-local', text: 'Logs cleared', at: action.at },
      );
    case 'clear-failed':
      return { ...state, clearError: true };
    case 'activity-loading':
      return { ...state, activity: { ...state.activity, load: { status: 'loading' } } };
    case 'activity-loaded': {
      const ids = new Set(action.entries.map((e) => e.id));
      const kept = state.activity.items.filter((i) => i.kind === 'local' || !ids.has(i.id));
      return {
        ...state,
        activity: { items: [...kept, ...action.entries], load: { status: 'ready' } },
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
        activity: { ...state.activity, items: [...state.activity.items, action.entry] },
      };
    }
    case 'activity-local': {
      const item: LocalActivity = {
        kind: 'local',
        id: `local-${action.at}-${state.activity.items.length}`,
        ts: action.at,
        text: action.text,
      };
      return { ...state, activity: { ...state.activity, items: [...state.activity.items, item] } };
    }
  }
}
