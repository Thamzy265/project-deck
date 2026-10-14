import type { LogEntry, WsMessage } from '@project-deck/core';
import { MAX_LOG_LIMIT } from '@project-deck/core';
import type { Dispatch } from 'react';
import type { DeckClient } from '../api/client.js';
import type { ActionKind, DeckAction, DeckState } from './deck.js';

export interface DeckActions {
  run(kind: ActionKind): void;
  attach(appId: string): void;
  clearLogs(): Promise<void>;
  loadLogs(limit?: number): void;
  loadActivity(): void;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error';
}

/** User actions and loads: each HTTP call, then the result into the reducer. */
export function createActions(
  client: DeckClient,
  dispatch: Dispatch<DeckAction>,
  getState: () => DeckState,
  now: () => number,
): DeckActions {
  return {
    loadLogs(limit = MAX_LOG_LIMIT) {
      dispatch({ type: 'logs-loading' });
      // Always merged: live lines may already have arrived while this was loading.
      client.logs(limit).then(
        (res) => dispatch({ type: 'logs-loaded', entries: res.entries, merge: true }),
        (err: unknown) => dispatch({ type: 'logs-failed', error: message(err) }),
      );
    },
    loadActivity() {
      dispatch({ type: 'activity-loading' });
      client.activity().then(
        (res) => dispatch({ type: 'activity-loaded', entries: res.entries }),
        (err: unknown) => dispatch({ type: 'activity-failed', error: message(err) }),
      );
    },
    run(kind) {
      const s = getState();
      if (s.running !== null || s.attached === null || s.connection.kind !== 'connected') return;
      dispatch({ type: 'action-start', kind, at: now() });
      (kind === 'reload' ? client.reload() : client.restart()).then(
        (result) => dispatch({ type: 'action-done', result, at: now() }),
        (err: unknown) => dispatch({ type: 'action-failed', message: message(err), at: now() }),
      );
    },
    attach(appId) {
      dispatch({ type: 'attach-start', appId });
      client.attach(appId).then(
        (app) => dispatch({ type: 'attached', app }),
        (err: unknown) => dispatch({ type: 'attach-failed', appId, error: message(err) }),
      );
    },
    async clearLogs() {
      try {
        await client.clearLogs();
        // The daemon's logs.cleared event follows and adds the Activity note.
        dispatch({ type: 'logs-cleared', at: now(), announce: false });
      } catch {
        dispatch({ type: 'clear-failed' });
      }
    },
  };
}

/** Turns a daemon message into reducer actions; log lines go through `queueLog`. */
export function handleMessage(
  msg: WsMessage,
  dispatch: Dispatch<DeckAction>,
  queueLog: (entry: LogEntry) => void,
  now: () => number,
): void {
  switch (msg.type) {
    case 'hello':
      dispatch({
        type: 'apps',
        apps: msg.payload.apps,
        attached: msg.payload.attached,
        discovering: msg.payload.discovering,
      });
      return;
    case 'heartbeat':
      return;
    case 'apps.discovering':
      dispatch({ type: 'discovering', discovering: msg.payload.discovering });
      return;
    case 'apps.changed':
      dispatch({ type: 'apps', apps: msg.payload.apps });
      return;
    case 'app.attached':
      dispatch({ type: 'attached', app: msg.payload.app });
      return;
    case 'app.detached':
      dispatch({ type: 'detached', appId: msg.payload.appId });
      return;
    case 'app.exit':
      dispatch({ type: 'exited', appId: msg.payload.appId });
      return;
    case 'app.reloaded':
      dispatch({ type: 'reloaded', result: msg.payload.result, at: now() });
      return;
    case 'app.log':
      queueLog(msg.payload.entry);
      return;
    case 'logs.cleared':
      dispatch({ type: 'logs-cleared', at: msg.payload.at, announce: true });
      return;
    case 'activity':
      dispatch({ type: 'activity-add', entry: msg.payload });
      return;
  }
}
