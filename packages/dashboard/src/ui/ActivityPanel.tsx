import { useMemo, useState } from 'react';
import type { ActivityItem } from '../state/deck.js';
import { useDeck } from '../state/DeckProvider.js';
import { Skeleton } from './Skeleton.js';
import { activityText, clock } from './format.js';
import { linkButton } from './styles.js';

/** Messages longer than this, or with several lines, get "Show more" after two lines. */
const LONG_MESSAGE = 120;

const ICON: Record<string, string> = {
  local: '•',
  'app.attached': '↗',
  'app.detached': '↙',
  'app.reloaded': '⟳',
  'app.stopped': '■',
  'app.crashed': '⚠',
  'claude.done': '✓',
  'claude.waiting': '…',
};

function text(item: ActivityItem): string {
  return item.kind === 'local' ? item.text : activityText(item);
}

function isFailure(item: ActivityItem): boolean {
  return item.kind === 'app.crashed' || (item.kind === 'app.reloaded' && !item.result.ok);
}

function Row({ item }: { item: ActivityItem }) {
  const [more, setMore] = useState(false);
  const body = text(item);
  const time = clock(item.ts, 'medium');
  const long =
    item.kind === 'claude.waiting' && (body.length > LONG_MESSAGE || body.includes('\n'));
  return (
    <li tabIndex={0} className="flex gap-2 px-2 py-1 hover:bg-surface">
      <span aria-hidden="true" className={isFailure(item) ? 'text-error' : 'text-muted'}>
        {ICON[item.kind] ?? '•'}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`whitespace-pre-wrap wrap-anywhere ${long && !more ? 'line-clamp-2' : ''}`}>
          {body}
        </p>
        {long && !more && (
          <button
            type="button"
            className={linkButton}
            aria-label={`Show more: Claude's message at ${time}`}
            onClick={() => setMore(true)}
          >
            Show more
          </button>
        )}
      </div>
      <time
        className="shrink-0 font-mono text-sm text-muted"
        dateTime={new Date(item.ts).toISOString()}
      >
        {time}
      </time>
    </li>
  );
}

export function ActivityPanel() {
  const { state, actions } = useDeck();
  const { items, load } = state.activity;
  // Kept sorted, oldest first, by the reducer; only reversed here.
  const newestFirst = useMemo(() => [...items].reverse(), [items]);
  if (load.status === 'loading' && items.length === 0) return <Skeleton label="Loading activity" />;
  if (load.status === 'error' && items.length === 0) {
    return (
      <p role="alert" className="p-2">
        Couldn't load activity.{' '}
        <button type="button" className={linkButton} onClick={() => actions.loadActivity()}>
          Retry
        </button>
      </p>
    );
  }
  if (items.length === 0) {
    return <p className="p-2">Nothing yet. Reloads, crashes and Claude's progress appear here</p>;
  }
  return (
    <ul aria-label="Activity" className="min-h-0 flex-1 overflow-y-auto">
      {newestFirst.map((item) => (
        <Row key={item.kind === 'local' ? item.id : `d${item.id}`} item={item} />
      ))}
    </ul>
  );
}
