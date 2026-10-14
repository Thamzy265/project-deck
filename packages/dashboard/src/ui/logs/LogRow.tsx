import type { CSSProperties, KeyboardEvent, Ref } from 'react';
import { memo } from 'react';
import type { KeyedLog } from '../../state/logs.js';
import { LEVEL_LETTER, LEVEL_NAME, clock } from '../format.js';
import { linkButton } from '../styles.js';

/** Entries longer than this collapse behind "Show more" (UI spec, "Logs list"). */
export const COLLAPSE_LINES = 4;

const LEVEL_COLOUR = {
  verbose: 'text-level-verbose',
  debug: 'text-level-debug',
  info: 'text-level-info',
  warn: 'text-level-warning',
  error: 'text-level-error',
  fatal: 'text-level-error',
} as const;

export function fullText(entry: KeyedLog): string {
  return entry.stack === undefined ? entry.message : `${entry.message}\n${entry.stack}`;
}

function copy(text: string): void {
  // Copying is best effort: the browser may refuse without a user gesture or permission.
  try {
    void navigator.clipboard.writeText(text).catch(() => undefined);
  } catch {
    // No clipboard API here (for example an insecure context).
  }
}

export const LogRow = memo(function LogRow({
  entry,
  expanded,
  onExpand,
  index,
  style,
  measureRef,
}: {
  entry: KeyedLog;
  index: number;
  /** Position inside the virtual list. */
  style: CSSProperties;
  measureRef: Ref<HTMLDivElement>;
  /** Kept by the list, so it survives the row scrolling out of the virtual window. */
  expanded: boolean;
  onExpand: (key: number) => void;
}) {
  const text = fullText(entry);
  const lines = text.split('\n');
  const long = lines.length > COLLAPSE_LINES;
  const shown = long && !expanded ? lines.slice(0, COLLAPSE_LINES).join('\n') : text;
  const time = clock(entry.ts, 'medium');
  const summary = `${time} ${entry.message.slice(0, 40)}`;

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && long && event.target === event.currentTarget) {
      event.preventDefault();
      onExpand(entry.key);
    }
  };

  return (
    <div
      ref={measureRef}
      data-index={index}
      style={style}
      role="listitem"
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="group flex flex-wrap gap-x-2 px-2 py-0.5 font-mono text-sm hover:bg-surface focus-within:bg-surface"
    >
      <span className="text-muted">
        <span className="pane:hidden">{clock(entry.ts, 'short')}</span>
        <span className="hidden pane:inline md:hidden">{time}</span>
        <span className="hidden md:inline">{clock(entry.ts, 'full')}</span>
      </span>
      <span className={LEVEL_COLOUR[entry.level]}>
        <span aria-hidden="true">{LEVEL_LETTER[entry.level]}</span>
        <span className="sr-only">{LEVEL_NAME[entry.level]}</span>
      </span>
      <span className="text-muted">{entry.source}</span>
      {entry.tag !== undefined && (
        <span className="hidden w-32 truncate text-muted md:inline" title={entry.tag}>
          {entry.tag}
        </span>
      )}
      <span className="min-w-0 flex-1 basis-full whitespace-pre-wrap wrap-anywhere pane:basis-0">
        {shown}
        {long && !expanded && (
          <>
            {' '}
            <button
              type="button"
              className={linkButton}
              aria-label={`Show more: ${summary}`}
              onClick={() => onExpand(entry.key)}
            >
              Show more
            </button>
          </>
        )}
      </span>
      <button
        type="button"
        aria-label={`Copy line: ${summary}`}
        className="absolute top-0 right-1 min-h-6 rounded-sm border border-border bg-bg px-2 font-sans opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100"
        onClick={() => copy(text)}
      >
        Copy line
      </button>
    </div>
  );
});
