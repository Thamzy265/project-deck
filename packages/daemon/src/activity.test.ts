import type { ActivityEntry, DeckEvents } from '@project-deck/core';
import { ACTIVITY_CAPACITY, ActivityEntrySchema, EventBus } from '@project-deck/core';
import { fakeApp } from '@project-deck/core/testing';
import { describe, expect, it } from 'vitest';
import { ActivityFeed } from './activity.js';

function setup(capacity?: number) {
  const bus = new EventBus<DeckEvents>();
  let clock = 1000;
  const feed = new ActivityFeed(bus, {
    now: () => clock++,
    ...(capacity === undefined ? {} : { capacity }),
  });
  const pushed: ActivityEntry[] = [];
  bus.on('activity', (entry) => pushed.push(entry));
  const stop = feed.start();
  return { bus, feed, pushed, stop };
}

describe('ActivityFeed', () => {
  it('records attach, reloads, detach, exits and Claude events in order', () => {
    const { bus, feed } = setup();
    const app = fakeApp();
    bus.emit('app.attached', { app });
    bus.emit('app.reloaded', {
      appId: app.id,
      result: { ok: true, kind: 'hot-reload', durationMs: 182 },
    });
    bus.emit('app.reloaded', {
      appId: app.id,
      result: { ok: true, kind: 'hot-reload', source: 'external' },
    });
    bus.emit('app.reloaded', {
      appId: app.id,
      result: { ok: false, reason: 'compile-error', message: 'x' },
    });
    bus.emit('app.exit', { appId: app.id, crashed: false });
    bus.emit('app.attached', { app });
    bus.emit('app.exit', { appId: app.id, code: 1, crashed: true });
    bus.emit('app.attached', { app });
    bus.emit('app.detached', { appId: app.id });
    bus.emit('claude.done', { sessionId: 's1' });
    bus.emit('claude.waiting', { message: 'Allow edit?' });

    const entries = feed.list();
    expect(entries.map((e) => e.kind)).toEqual([
      'app.attached',
      'app.reloaded',
      'app.reloaded',
      'app.reloaded',
      'app.stopped',
      'app.attached',
      'app.crashed',
      'app.attached',
      'app.detached',
      'claude.done',
      'claude.waiting',
    ]);
    expect(entries.map((e) => e.id)).toEqual([...Array(11).keys()]);
    expect(entries[0]).toEqual({
      id: 0,
      ts: 1000,
      kind: 'app.attached',
      appId: app.id,
      appName: app.name,
    });
    expect(entries[2]).toMatchObject({ result: { source: 'external' } });
    expect(entries[6]).toMatchObject({ kind: 'app.crashed', code: 1, appName: app.name });
    expect(entries[9]).toEqual({ id: 9, ts: 1009, kind: 'claude.done', sessionId: 's1' });
    expect(entries[10]).toMatchObject({ kind: 'claude.waiting', message: 'Allow edit?' });
    for (const entry of entries) expect(ActivityEntrySchema.parse(entry)).toEqual(entry);
  });

  it('pushes each new entry on the bus, after the event that caused it', async () => {
    const { bus, pushed, feed } = setup();
    const order: string[] = [];
    bus.onAny((type) => order.push(type));
    bus.emit('claude.done', {});
    expect(feed.list()).toHaveLength(1);
    await Promise.resolve();
    expect(pushed).toEqual(feed.list());
    expect(order).toEqual(['claude.done', 'activity']);
  });

  it('keeps only the newest entries, 500 by default', () => {
    const { bus, feed } = setup(3);
    for (let i = 0; i < 5; i++) bus.emit('claude.done', { sessionId: `s${i}` });
    expect(feed.list().map((e) => e.id)).toEqual([2, 3, 4]);
    expect(ACTIVITY_CAPACITY).toBe(500);
    const full = setup();
    for (let i = 0; i < ACTIVITY_CAPACITY + 10; i++) full.bus.emit('claude.done', {});
    expect(full.feed.list()).toHaveLength(ACTIVITY_CAPACITY);
    expect(full.feed.list()[0]?.id).toBe(10);
  });

  it('names apps it saw only in the app list, and falls back to the id', () => {
    const { bus, feed } = setup();
    bus.emit('apps.changed', { connectorId: 'fake', apps: [fakeApp({ id: 'a2', name: 'two' })] });
    bus.emit('app.detached', { appId: 'a2' });
    bus.emit('app.detached', { appId: 'unknown' });
    expect(feed.list().map((e) => ('appName' in e ? e.appName : ''))).toEqual(['two', 'unknown']);
  });

  it('stores only the fields the schema allows from a waiting event', () => {
    const { bus, feed } = setup();
    const payload = {
      message: 'm',
      last_assistant_message: 'secret',
    } as DeckEvents['claude.waiting'];
    bus.emit('claude.waiting', payload);
    expect(feed.list()[0]).not.toHaveProperty('last_assistant_message');
  });

  it('stops listening when stopped', () => {
    const { bus, feed, stop } = setup();
    stop();
    bus.emit('claude.done', {});
    expect(feed.list()).toEqual([]);
  });

  it('keeps names only for listed apps and the attached one', () => {
    const { bus, feed } = setup();
    const gone = fakeApp({ id: 'gone', name: 'gone-app' });
    const kept = fakeApp({ id: 'kept', name: 'kept-app' });
    bus.emit('apps.changed', { connectorId: 'fake', apps: [gone, kept] });
    bus.emit('app.attached', { app: kept });
    // Both leave the list; only the attached one keeps its name until its exit.
    bus.emit('apps.changed', { connectorId: 'fake', apps: [] });
    bus.emit('app.detached', { appId: 'gone' });
    bus.emit('app.exit', { appId: 'kept', crashed: false });
    bus.emit('app.reloaded', { appId: 'kept', result: { ok: true, kind: 'hot-reload' } });
    const names = feed.list().map((e) => ('appName' in e ? e.appName : ''));
    expect(names).toEqual(['kept-app', 'gone', 'kept-app', 'kept']);
  });
});
