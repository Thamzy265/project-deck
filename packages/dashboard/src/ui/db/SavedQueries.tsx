import type { SavedQuery } from '@project-deck/core';
import { MAX_SAVED_QUERIES } from '@project-deck/core';
import { useCallback, useEffect, useState } from 'react';
import { asDbApiError } from '../../api/db-client.js';
import { visibleText } from '../../db/cells.js';
import { useDbClient } from '../../state/DbProvider.js';
import { button, field } from '../styles.js';
import { VisibleText } from './VisibleText.js';

const NAME_LENGTH = 40;

export interface SavedQueries {
  queries: SavedQuery[];
  error: string | undefined;
  /** Replaces the list in `.flutterdeck/queries.json`; resolves false when it failed. */
  save: (queries: SavedQuery[]) => Promise<boolean>;
}

/** The project's saved queries, read once per attach. */
export function useSavedQueries(appId: string | undefined): SavedQueries {
  const client = useDbClient();
  const [queries, setQueries] = useState<SavedQuery[]>([]);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    if (appId === undefined) return;
    let cancelled = false;
    client.savedQueries().then(
      (q) => {
        if (!cancelled) setQueries(q);
      },
      (err: unknown) => {
        if (!cancelled) setError(asDbApiError(err).message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, appId]);
  const save = useCallback(
    async (next: SavedQuery[]) => {
      try {
        setQueries(await client.saveQueries(next));
        setError(undefined);
        return true;
      } catch {
        setError("Couldn't save queries");
        return false;
      }
    },
    [client],
  );
  return { queries, error, save };
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
      {queries.length === 0 ? (
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
                      void saved
                        .save(
                          queries.map((x, j) => (j === i ? { ...x, name: next.slice(0, 100) } : x)),
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
                  onClick={() => void saved.save(queries.filter((_, j) => j !== i))}
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
