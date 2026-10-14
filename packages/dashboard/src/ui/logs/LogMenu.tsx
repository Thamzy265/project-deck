import type { LogEntry } from '@project-deck/core';
import type { LogFilters } from '../../state/logs.js';
import { button, field } from '../styles.js';

const SOURCES: { value: LogEntry['source'] | 'all'; label: string }[] = [
  { value: 'all', label: 'All sources' },
  { value: 'app', label: 'App' },
  { value: 'framework', label: 'Framework' },
  { value: 'native', label: 'Native' },
  { value: 'tool', label: 'Tool' },
];

function isSource(value: string): value is LogEntry['source'] | 'all' {
  return SOURCES.some((s) => s.value === value);
}

export interface LogMenuProps {
  filters: LogFilters;
  onChange: (f: LogFilters) => void;
  tags: string[];
  paused: boolean;
  onTogglePause: () => void;
  canClear: boolean;
  onClear: () => void;
  shortcuts: boolean;
  onToggleShortcuts: () => void;
}

/** The ⋯ menu: source, tag, since last reload, pause, clear and the shortcuts switch. */
export function LogMenu(p: LogMenuProps) {
  const { filters, onChange } = p;
  return (
    <div
      id="log-menu"
      className="flex flex-wrap items-center gap-2 border-y border-border bg-surface p-2"
    >
      <label className="flex items-center gap-1">
        <span>Source</span>
        <select
          className={field}
          value={filters.source}
          onChange={(e) => {
            if (isSource(e.target.value)) onChange({ ...filters, source: e.target.value });
          }}
        >
          {SOURCES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-w-0 items-center gap-1">
        <span>Tag</span>
        <select
          className={`${field} max-w-40`}
          value={filters.tag}
          onChange={(e) => onChange({ ...filters, tag: e.target.value })}
        >
          <option value="">All tags</option>
          {p.tags.map((tag) => (
            <option key={tag} value={tag}>
              {tag}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-h-6 items-center gap-1">
        <input
          type="checkbox"
          className="size-4 accent-accent"
          checked={filters.sinceReload}
          onChange={(e) => onChange({ ...filters, sinceReload: e.target.checked })}
        />
        <span>Since last reload</span>
      </label>
      <button type="button" className={button} onClick={p.onTogglePause}>
        {p.paused ? 'Follow new logs' : 'Pause'}
      </button>
      <button
        type="button"
        className={button}
        aria-disabled={p.canClear ? undefined : true}
        title={p.canClear ? undefined : 'No logs'}
        onClick={() => {
          if (p.canClear) p.onClear();
        }}
      >
        Clear logs
      </button>
      <button
        type="button"
        role="switch"
        aria-checked={p.shortcuts}
        className={button}
        onClick={p.onToggleShortcuts}
      >
        Keyboard shortcuts r / R: {p.shortcuts ? 'on' : 'off'}
      </button>
    </div>
  );
}
