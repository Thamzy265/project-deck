import type { LogLevel } from '@project-deck/core';
import type { LogFilters as Filters } from '../../state/logs.js';
import { MAX_SEARCH_LENGTH, compileSearch } from '../../state/logs.js';
import { field, headerButton } from '../styles.js';

const LEVELS: { value: LogLevel | 'all'; label: string }[] = [
  { value: 'all', label: 'All levels' },
  { value: 'debug', label: 'Debug' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warning' },
  { value: 'error', label: 'Error' },
];

function isLevel(value: string): value is LogLevel | 'all' {
  return LEVELS.some((l) => l.value === value);
}

function searchError(search: string, tooSlow: boolean): string | undefined {
  const compiled = compileSearch(search);
  if (!compiled.ok) {
    return compiled.reason === 'unsafe'
      ? 'That pattern could freeze the page. Try a simpler one.'
      : "That pattern isn't valid";
  }
  return tooSlow ? 'That search took too long and was stopped.' : undefined;
}

export function LogFilterBar({
  filters,
  onChange,
  menuOpen,
  onToggleMenu,
  tooSlow = false,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  menuOpen: boolean;
  onToggleMenu: () => void;
  /** The last search pass ran past its time budget and was stopped. */
  tooSlow?: boolean;
}) {
  const error = searchError(filters.search, tooSlow);
  const invalid = error !== undefined;
  return (
    <div className="flex flex-wrap items-start gap-2 p-2">
      <div className="flex min-w-0 basis-full flex-col pane:flex-1 pane:basis-0">
        <label htmlFor="log-search" className="sr-only">
          Search logs
        </label>
        <input
          id="log-search"
          type="search"
          className={field}
          placeholder="Search logs…"
          maxLength={MAX_SEARCH_LENGTH}
          value={filters.search}
          aria-invalid={invalid}
          aria-describedby={invalid ? 'log-search-error' : undefined}
          onChange={(e) => onChange({ ...filters, search: e.target.value })}
        />
        {invalid && (
          <p id="log-search-error" className="text-sm text-error">
            {error}
          </p>
        )}
      </div>
      <label htmlFor="log-level" className="sr-only">
        Level
      </label>
      <select
        id="log-level"
        className={field}
        value={filters.minLevel}
        onChange={(e) => {
          if (isLevel(e.target.value)) onChange({ ...filters, minLevel: e.target.value });
        }}
      >
        {LEVELS.map((l) => (
          <option key={l.value} value={l.value}>
            {l.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={headerButton}
        aria-label="More log options"
        aria-expanded={menuOpen}
        aria-controls="log-menu"
        onClick={onToggleMenu}
      >
        <span aria-hidden="true">⋯</span>
      </button>
    </div>
  );
}
