import type { RefObject } from 'react';
import { useMemo, useRef, useState } from 'react';
import { useDeck } from '../../state/DeckProvider.js';
import type { LogFilters } from '../../state/logs.js';
import { NO_FILTERS, compileSearch, filterLogs, filtersActive } from '../../state/logs.js';
import type { RegexRunner } from '../../search/runner.js';
import { useRegexSearch } from '../../search/useRegexSearch.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import { Skeleton } from '../Skeleton.js';
import { linkButton } from '../styles.js';
import { LogFilterBar } from './LogFilters.js';
import { LogList } from './LogList.js';
import { LogMenu } from './LogMenu.js';

const MAX_TAGS = 200;

type Pause = { paused: false } | { paused: true; by: 'scroll' | 'manual'; afterKey: number };

export interface LogsPanelProps {
  filters: LogFilters;
  onFiltersChange: (f: LogFilters) => void;
  shortcuts: boolean;
  onToggleShortcuts: () => void;
  listRef: RefObject<HTMLDivElement | null>;
  /** Runs the search pattern off the page's thread (BUG-M2-T1). */
  search: RegexRunner;
}

export function LogsPanel(props: LogsPanelProps) {
  const { state, actions } = useDeck();
  const { filters, onFiltersChange } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pause, setPause] = useState<Pause>({ paused: false });
  const menuButton = useRef<HTMLDivElement>(null);

  const all = state.logs.entries;
  const reloadMark = state.lastResult?.mark;
  // Level, source, tag and time here; the pattern in the search worker.
  const base = useMemo(() => filterLogs(all, filters, reloadMark), [all, filters, reloadMark]);
  const pattern = compileSearch(filters.search).ok ? filters.search : '';
  const { shown, tooSlow } = useRegexSearch(props.search, base, pattern);
  const tags = useMemo(() => {
    const set = new Set<string>();
    for (const e of all) if (e.tag !== undefined && set.size < MAX_TAGS) set.add(e.tag);
    return [...set].sort();
  }, [all]);
  const lastKey = all.at(-1)?.key ?? -1;
  const newLines = pause.paused ? shown.filter((e) => e.key > pause.afterKey).length : 0;
  const active = filtersActive(filters);
  const connected = state.connection.kind === 'connected';

  const pauseNow = (by: 'scroll' | 'manual') => {
    if (!pause.paused) setPause({ paused: true, by, afterKey: lastKey });
  };
  const follow = () => setPause({ paused: false });
  const focusMenuButton = () =>
    menuButton.current
      ?.querySelector<HTMLButtonElement>('button[aria-controls="log-menu"]')
      ?.focus();

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && menuOpen && !confirming) {
          setMenuOpen(false);
          focusMenuButton();
        }
      }}
    >
      <div ref={menuButton}>
        <LogFilterBar
          filters={filters}
          onChange={onFiltersChange}
          menuOpen={menuOpen}
          onToggleMenu={() => setMenuOpen(!menuOpen)}
          tooSlow={tooSlow}
        />
      </div>
      {menuOpen && (
        <LogMenu
          filters={filters}
          onChange={onFiltersChange}
          tags={tags}
          paused={pause.paused}
          onTogglePause={() => (pause.paused ? follow() : pauseNow('manual'))}
          canClear={connected && all.length > 0}
          onClear={() => setConfirming(true)}
          shortcuts={props.shortcuts}
          onToggleShortcuts={props.onToggleShortcuts}
        />
      )}
      {state.clearError && (
        <p role="alert" className="px-2 text-sm text-error">
          Couldn't clear logs
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-2 px-2 text-sm text-muted">
        <span>
          {active
            ? `Showing ${shown.length.toLocaleString('en')} of ${all.length.toLocaleString('en')}`
            : ''}
        </span>
        {pause.paused ? (
          <span>
            Paused — {newLines} new {newLines === 1 ? 'line' : 'lines'} ·{' '}
            <button type="button" className={linkButton} onClick={follow}>
              Jump to latest
            </button>
          </span>
        ) : (
          <span>Following new logs</span>
        )}
      </div>
      <LogBody
        shown={shown}
        filtersOn={active}
        onClearFilters={() => onFiltersChange(NO_FILTERS)}
        following={!pause.paused}
        onScrolledAway={() => pauseNow('scroll')}
        onScrolledToEnd={() => {
          if (pause.paused && pause.by === 'scroll') follow();
        }}
        listRef={props.listRef}
      />
      {confirming && (
        <ConfirmDialog
          question="Clear all logs? This can't be undone."
          confirmLabel="Clear logs"
          onCancel={() => {
            setConfirming(false);
            focusMenuButton();
          }}
          onConfirm={() => {
            setConfirming(false);
            focusMenuButton();
            void actions.clearLogs();
          }}
        />
      )}
    </div>
  );
}

function LogBody(p: {
  shown: ReturnType<typeof filterLogs>;
  filtersOn: boolean;
  onClearFilters: () => void;
  following: boolean;
  onScrolledAway: () => void;
  onScrolledToEnd: () => void;
  listRef: RefObject<HTMLDivElement | null>;
}) {
  const { state, actions } = useDeck();
  const load = state.logs.load;
  if (load.status === 'loading' && state.logs.entries.length === 0)
    return <Skeleton label="Loading logs" />;
  if (load.status === 'error' && state.logs.entries.length === 0) {
    return (
      <p role="alert" className="p-2">
        Couldn't load logs: {load.error}.{' '}
        <button type="button" className={linkButton} onClick={() => actions.loadLogs()}>
          Retry
        </button>
      </p>
    );
  }
  if (p.shown.length === 0) {
    return (
      <div className="p-2">
        <p>No logs yet. Use your app, or clear filters</p>
        {p.filtersOn && (
          <button type="button" className={linkButton} onClick={p.onClearFilters}>
            Clear filters
          </button>
        )}
      </div>
    );
  }
  return (
    <LogList
      entries={p.shown}
      following={p.following}
      onScrolledAway={p.onScrolledAway}
      onScrolledToEnd={p.onScrolledToEnd}
      listRef={p.listRef}
    />
  );
}
