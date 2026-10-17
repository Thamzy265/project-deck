import type { DeckEvents } from '@project-deck/core';
import { EventBus } from '@project-deck/core';
import { describe, expect, it } from 'vitest';
import { ActivityFeed } from './activity.js';

describe('ActivityFeed: database entries', () => {
  it('records snapshots, diffs and edits the user allowed or denied', () => {
    const bus = new EventBus<DeckEvents>();
    const feed = new ActivityFeed(bus, { now: () => 5 });
    feed.start();
    bus.emit('db.snapshot', { db: 'app' });
    bus.emit('db.diff', { db: 'app' });
    bus.emit('db.write', { db: 'app', tables: ['orders'], allowed: true, changes: 2 });
    bus.emit('db.write', { db: 'app', tables: ['orders'], allowed: false });
    expect(feed.list()).toEqual([
      { id: 0, ts: 5, kind: 'db.snapshot', db: 'app' },
      { id: 1, ts: 5, kind: 'db.diff', db: 'app' },
      { id: 2, ts: 5, kind: 'db.write', db: 'app', tables: ['orders'], allowed: true, changes: 2 },
      { id: 3, ts: 5, kind: 'db.write', db: 'app', tables: ['orders'], allowed: false },
    ]);
  });

  it('keeps nothing beyond the schema from a write event (no SQL)', () => {
    const bus = new EventBus<DeckEvents>();
    const feed = new ActivityFeed(bus);
    feed.start();
    const payload = {
      db: 'app',
      tables: ['orders'],
      allowed: true,
      changes: 1,
      sql: 'DELETE FROM orders',
    } as DeckEvents['db.write'];
    bus.emit('db.write', payload);
    expect(feed.list()[0]).not.toHaveProperty('sql');
  });
});
