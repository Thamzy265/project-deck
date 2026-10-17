import type { SavedQueriesState, SavedQuery } from '@project-deck/core';
import { MAX_SAVED_QUERIES } from '@project-deck/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { asDbApiError } from '../../api/db-client.js';
import { visibleText } from '../../db/cells.js';
import { useDbClient } from '../../state/DbProvider.js';
import { Skeleton } from '../Skeleton.js';
import { button, field, linkButton } from '../styles.js';
import { VisibleText } from './VisibleText.js';

const NAME_LENGTH = 40;

export interface SavedQueries {
  /** Null until the list has loaded: nothing can be saved before (review R1). */
  queries: SavedQuery[] | null;
  /** Why the list couldn't be read or saved. */
  error: string | undefined;
  /** Reads the list again after a failed load. */
  reload: () => void;
  /**
   * Changes the list in `.flutterdeck/queries.json`: `change` gets the current list and
   * answers the new one (or undefined for no room). The save names the revision it was
   * made from; when another tab saved since, the list is read again and `change` runs
   * on it once more, so neither tab's queries are lost. Resolves true when it saved.
   */
  update: (change: (queries: SavedQuery[]) => SavedQuery[] | undefined) => Promise<boolean>;
}

/** The project's saved queries, read once per attach. */
export function useSavedQueries(appId: string | undefined): SavedQueries {
  const client = useDbClient();
  const [state, setState] = useState<SavedQueriesState | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [run, setRun] = useState(0);
  const latest = useRef<SavedQueriesState | null>(null);
  latest.current = state;
  useEffect(() => {
    if (appId === undefined) return;
    let cancelled = false;
    setState(null);
    client.savedQueries().then(
      (s) => {
        if (cancelled) return;
        setState(s);
        setError(undefined);
      },
      (err: unknown) => {
        if (!cancelled) setError(asDbApiError(err).message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, appId, run]);
  const update = useCallback(
    async (change: (queries: SavedQuery[]) => SavedQuery[] | undefined) => {
      let base = latest.current;
      if (base === null) {
        // Keep the load error: it says why there is nothing to save to.
        setError((e) => e ?? "Couldn't save queries");
        return false;
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const next = change(base.queries);
        if (next === undefined) {
          setError("Couldn't save queries");
          return false;
        }
        if (next === base.queries) return true;
        try {
          const saved = await client.saveQueries(next, base.revision);
          setState(saved);
          setError(undefined);
          return true;
        } catch (err) {
          if (asDbApiError(err).code !== 'conflict' || attempt > 0) break;
          try {
            base = await client.savedQueries();
            setState(base);
          } catch {
            break;
          }
        }
      }
      setError("Couldn't save queries");
      return false;
    },
    [client],
  );
  const reload = useCallback(() => setRun((n) => n + 1), []);
  return { queries: state?.queries ?? null, error, reload, update };
}

/** A name from the query's first line, unique in the list. */
export function nameFor(sql: string, taken: readonly SavedQuery[]): string {
  const first = sql.trim().split('\n')[0]?.trim() ?? '';
  const base = (first.length > NAME_LENGTH ? `${first.slice(0, NAME_LENGTH)}…` : first) || 'Query';
  const names = new Set(taken.map((q) => q.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} (${i})`)) return `${base} (${i})`;
}

/** Adds `sql` unless it is already saved; false when there is no room. */
export function withQuery(queries: SavedQuery[], sql: string): SavedQuery[] | undefined {
  if (queries.some((q) => q.sql === sql)) return queries;
  if (queries.length >= MAX_SAVED_QUERIES) return undefined;
  return [...queries, { name: nameFor(sql, queries), sql }];
}

/** The ⋯ menu's saved queries (UI spec): name, Run, Rename, Delete. */
export function SavedQueriesMenu({
  saved,
  onRun,
  onClose,
}: {
  saved: SavedQueries;
  onRun: (query: SavedQuery) => void;
  onClose: () => void;
}) {
  const [renaming, setRenaming] = useState<number | undefined>();
  const [draft, setDraft] = useState('');
  const { queries } = saved;
  return (
    <div
      id="db-menu"
      className="flex flex-col gap-1 border-y border-border bg-surface p-2"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && renaming === undefined) onClose();
      }}
    >
      <h2 className="sr-only">Saved queries</h2>
      {saved.error !== undefined && (
        <p role="alert" className="text-error">
          {saved.error}
        </p>
      )}
      {queries === null ? (
        saved.error === undefined ? (
          <Skeleton label="Loading saved queries" />
        ) : (
          <button type="button" className={linkButton} onClick={saved.reload}>
            Retry
          </button>
        )
      ) : queries.length === 0 ? (
        <p>No saved queries. Save the current query with Cmd/Ctrl+S</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {queries.map((q, i) => {
            const name = visibleText(q.name);
            return (
              <li key={`${q.name}-${i}`} className="flex flex-wrap items-center gap-1">
                {renaming === i ? (
                  <form
                    className="flex min-w-0 flex-1 gap-1"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const next = draft.trim();
                      if (next === '') return;
                      // By name and SQL, not position: after a conflict the list is new.
                      void saved
                        .update((list) =>
                          list.map((x) =>
                            x.name === q.name && x.sql === q.sql
                              ? { ...x, name: next.slice(0, 100) }
                              : x,
                          ),
                        )
                        .then(() => setRenaming(undefined));
                    }}
                  >
                    <label htmlFor={`rename-${i}`} className="sr-only">
                      New name for {name}
                    </label>
                    <input
                      id={`rename-${i}`}
                      className={`${field} min-w-0 flex-1`}
                      value={draft}
                      maxLength={100}
                      autoFocus
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.stopPropagation();
                          setRenaming(undefined);
                        }
                      }}
                    />
                    <button type="submit" className={button}>
                      Save name
                    </button>
                  </form>
                ) : (
                  <span className="min-w-0 flex-1 truncate" title={name}>
                    <VisibleText text={q.name} />
                  </span>
                )}
                <button
                  type="button"
                  className={button}
                  aria-label={`Run saved query: ${name}`}
                  onClick={() => onRun(q)}
                >
                  Run
                </button>
                <button
                  type="button"
                  className={button}
                  aria-label={`Rename saved query: ${name}`}
                  onClick={() => {
                    setDraft(q.name);
                    setRenaming(i);
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className={button}
                  aria-label={`Delete saved query: ${name}`}
                  onClick={() =>
                    void saved.update((list) =>
                      list.filter((x) => !(x.name === q.name && x.sql === q.sql)),
                    )
                  }
                >
                  Delete
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
