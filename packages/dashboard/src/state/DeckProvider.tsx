import type { LogEntry } from '@project-deck/core';
import type { ReactNode } from 'react';
import { createContext, use, useEffect, useMemo, useReducer, useRef } from 'react';
import type { DeckClient } from '../api/client.js';
import { HttpError } from '../api/client.js';
import type { SocketLike, StatusCheck } from '../api/connection.js';
import { Connection } from '../api/connection.js';
import type { DeckState } from './deck.js';
import { deckReducer, initialState } from './deck.js';
import type { DeckActions } from './ops.js';
import { createActions, handleMessage } from './ops.js';
import type { SessionGuard } from './storage.js';

/** Design note, "Failure plan": after a reconnect, re-read the last 500 log lines. */
export const RECONNECT_LOG_LINES = 500;
/** New log lines are batched briefly so a chatty app doesn't re-render per line. */
export const LOG_FLUSH_MS = 50;

interface DeckContextValue {
  state: DeckState;
  actions: DeckActions;
}

const DeckContext = createContext<DeckContextValue | undefined>(undefined);

export interface DeckDeps {
  client: DeckClient;
  openSocket: () => SocketLike;
  guard: SessionGuard;
  reloadPage: () => void;
  now: () => number;
}

export function DeckProvider({ deps, children }: { deps: DeckDeps; children: ReactNode }) {
  const [state, dispatch] = useReducer(deckReducer, initialState);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const actions = useMemo(
    () => createActions(deps.client, dispatch, () => stateRef.current, deps.now),
    [deps],
  );

  useEffect(() => {
    let pending: LogEntry[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const queueLog = (entry: LogEntry): void => {
      pending.push(entry);
      flushTimer ??= setTimeout(() => {
        flushTimer = undefined;
        const entries = pending;
        pending = [];
        dispatch({ type: 'logs-append', entries });
      }, LOG_FLUSH_MS);
    };

    const checkStatus = async (): Promise<StatusCheck> => {
      try {
        dispatch({ type: 'status', status: await deps.client.status() });
        return 'ok';
      } catch (err) {
        return err instanceof HttpError && err.status === 401 ? 'unauthorized' : 'unreachable';
      }
    };

    const connection = new Connection({
      openSocket: deps.openSocket,
      checkStatus,
      guard: deps.guard,
      reloadPage: deps.reloadPage,
      onState: (s) => dispatch({ type: 'connection', state: s }),
      onMessage: (m) => handleMessage(m, dispatch, queueLog, deps.now),
      onOpen: (reconnect) => {
        void checkStatus();
        actions.loadLogs(reconnect ? RECONNECT_LOG_LINES : undefined);
        actions.loadActivity();
        if (reconnect) dispatch({ type: 'activity-local', text: 'Reconnected', at: deps.now() });
      },
    });
    connection.start();
    return () => {
      connection.stop();
      clearTimeout(flushTimer);
    };
  }, [deps, actions]);

  const value = useMemo(() => ({ state, actions }), [state, actions]);
  return <DeckContext value={value}>{children}</DeckContext>;
}

export function useDeck(): DeckContextValue {
  const value = use(DeckContext);
  if (value === undefined) throw new Error('useDeck needs a DeckProvider');
  return value;
}
