import { useCallback, useRef, useState } from 'react';
import { useDeck } from '../state/DeckProvider.js';
import type { LogFilters } from '../state/logs.js';
import { NO_FILTERS } from '../state/logs.js';
import type { StorageSource } from '../state/storage.js';
import { readShortcutsEnabled, writeShortcutsEnabled } from '../state/storage.js';
import { ActivityPanel } from './ActivityPanel.js';
import { Header } from './header/Header.js';
import { LogsPanel } from './logs/LogsPanel.js';
import { DaemonDownPage, LoadingPage, LoginNeededPage, ReauthPage } from './PageState.js';
import { ConnectionBanner, Footer } from './StatusBits.js';
import { Tabs } from './Tabs.js';
import { useShortcuts } from './useShortcuts.js';

type TabId = 'logs' | 'activity';

export function App({ prefs }: { prefs: StorageSource }) {
  const { state, actions } = useDeck();
  const [tab, setTab] = useState<TabId>('logs');
  const [filters, setFilters] = useState<LogFilters>(NO_FILTERS);
  const [shortcuts, setShortcuts] = useState(() => readShortcutsEnabled(prefs));
  const listRef = useRef<HTMLDivElement>(null);

  const run = useCallback((kind: 'reload' | 'restart') => actions.run(kind), [actions]);
  useShortcuts(shortcuts && state.info !== undefined, run);

  const toggleShortcuts = () => {
    writeShortcutsEnabled(prefs, !shortcuts);
    setShortcuts(!shortcuts);
  };
  const showLogs = () => {
    setTab('logs');
    // Focus once the panel is visible again; with no lines to show, the Logs tab itself.
    requestAnimationFrame(() => (listRef.current ?? document.getElementById('tab-logs'))?.focus());
  };

  const c = state.connection.kind;
  if (c === 'login-refused') return <LoginNeededPage />;
  if (c === 'reauth') return <ReauthPage />;
  if (state.info === undefined) return c === 'retrying' ? <DaemonDownPage /> : <LoadingPage />;

  return (
    <>
      <a
        href="#logs-list"
        className="sr-only focus:not-sr-only focus:absolute focus:top-1 focus:left-1 focus:z-20 focus:bg-bg focus:p-2"
        onClick={(e) => {
          e.preventDefault();
          showLogs();
        }}
      >
        Skip to logs
      </a>
      <div className="mx-auto flex h-dvh max-w-(--breakpoint-wide) flex-col">
        <Header
          shortcuts={shortcuts}
          onShowInLogs={() => {
            setFilters({ ...filters, minLevel: 'error', sinceReload: true });
            showLogs();
          }}
        />
        <ConnectionBanner />
        <main className="flex min-h-0 flex-1 flex-col">
          <h1 className="sr-only">FlutterDeck</h1>
          <Tabs<TabId>
            selected={tab}
            onSelect={setTab}
            tabs={[
              {
                id: 'logs',
                label: 'Logs',
                panel: (
                  <LogsPanel
                    filters={filters}
                    onFiltersChange={setFilters}
                    shortcuts={shortcuts}
                    onToggleShortcuts={toggleShortcuts}
                    listRef={listRef}
                  />
                ),
              },
              { id: 'activity', label: 'Activity', panel: <ActivityPanel /> },
            ]}
          />
        </main>
        <Footer />
      </div>
    </>
  );
}
