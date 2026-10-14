import { useVirtualizer } from '@tanstack/react-virtual';
import type { RefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyedLog } from '../../state/logs.js';
import { LogRow } from './LogRow.js';

/** How close to the end still counts as "at the bottom", in px. */
const BOTTOM_SLACK = 8;

export interface LogListProps {
  entries: KeyedLog[];
  following: boolean;
  /** The user scrolled up (pause) or back to the end (follow). */
  onScrolledAway: () => void;
  onScrolledToEnd: () => void;
  listRef: RefObject<HTMLDivElement | null>;
}

export function LogList({
  entries,
  following,
  onScrolledAway,
  onScrolledToEnd,
  listRef,
}: LogListProps) {
  const lastTop = useRef(0);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const onExpand = useCallback((key: number) => setExpanded((prev) => new Set(prev).add(key)), []);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 22,
    overscan: 12,
    getItemKey: (index) => entries[index]?.key ?? index,
    // jsdom has no layout; a starting size lets tests render rows. Browsers measure.
    initialRect: { width: 420, height: 600 },
  });

  const lastKey = entries.at(-1)?.key;
  useEffect(() => {
    if (following && entries.length > 0)
      virtualizer.scrollToIndex(entries.length - 1, { align: 'end' });
  }, [following, lastKey, entries.length, virtualizer]);

  const onScroll = () => {
    const el = listRef.current;
    if (el === null) return;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
    if (atEnd) onScrolledToEnd();
    else if (el.scrollTop < lastTop.current) onScrolledAway();
    lastTop.current = el.scrollTop;
  };

  return (
    <div
      ref={listRef}
      id="logs-list"
      role="list"
      aria-label="Log lines"
      tabIndex={0}
      onScroll={onScroll}
      className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
    >
      <div role="none" className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const entry = entries[item.index];
          if (entry === undefined) return null;
          return (
            <LogRow
              key={item.key}
              index={item.index}
              entry={entry}
              expanded={expanded.has(entry.key)}
              onExpand={onExpand}
              measureRef={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${item.start}px)`,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
