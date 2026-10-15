import type { ActivityEntry, DeckEvents } from '@project-deck/core';
import { ActivityEntrySchema, EventBus } from '@project-deck/core';
import { fakeApp } from '@project-deck/core/testing';
import { describe, expect, it } from 'vitest';
import { ActivityFeed, RELOAD_MERGE_WINDOW_MS } from './activity.js';

function setup() {
  const bus = new EventBus<DeckEvents>();
  const clock = { now: 10_000 };
  const feed = new ActivityFeed(bus, { now: () => clock.now });
  const pushed: ActivityEntry[] = [];
  bus.on('activity', (entry) => pushed.push(entry));
  feed.start();
  const app = fakeApp();
  bus.emit('app.attached', { app });
  const vmSuccess = (kind: 'hot-reload' | 'hot-restart' = 'hot-reload') =>
    bus.emit('app.reloaded', { appId: app.id, result: { ok: true, kind, source: 'external' } });
  const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));
  return { bus, feed, clock, pushed, app, vmSuccess, flush };
}

const reloads = (feed: ActivityFeed) => feed.list().filter((e) => e.kind !== 'app.attached');

describe('ActivityFeed and the reload hook', () => {
  it("records Claude's reload result with the attached app", () => {
    const { bus, feed, app } = setup();
    bus.emit('claude.reload', {
      sessionId: 's1',
      ok: false,
      kind: 'hot-reload',
      message: 'Hot reload failed.',
    });
    const [entry] = reloads(feed);
    expect(entry).toEqual({
      id: 1,
      ts: 10_000,
      kind: 'claude.reload',
      sessionId: 's1',
      ok: false,
      reload: 'hot-reload',
      message: 'Hot reload failed.',
      appId: app.id,
      appName: app.name,
    });
    expect(ActivityEntrySchema.parse(entry)).toEqual(entry);
  });

  it('leaves the app out when none is attached', () => {
    const { bus, feed, app } = setup();
    bus.emit('app.detached', { appId: app.id });
    bus.emit('claude.reload', { ok: true, kind: 'hot-restart' });
    expect(feed.list().at(-1)).toEqual({
      id: 2,
      ts: 10_000,
      kind: 'claude.reload',
      ok: true,
      reload: 'hot-restart',
    });
  });

  it('replaces a VM "success" that came up to 3 s before, keeping its id and time', async () => {
    const { bus, feed, clock, pushed, vmSuccess, flush } = setup();
    vmSuccess();
    const vm = feed.list().at(-1);
    clock.now += RELOAD_MERGE_WINDOW_MS;
    bus.emit('claude.reload', { ok: false, kind: 'hot-reload', message: 'Hot reload failed.' });
    await flush();

    const list = reloads(feed);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: vm?.id,
      ts: vm?.ts,
      kind: 'claude.reload',
      ok: false,
      reload: 'hot-reload',
    });
    // Announced again under the same id, so open dashboards replace the row.
    const announced = pushed.filter((e) => e.id === vm?.id);
    expect(announced.map((e) => e.kind)).toEqual(['app.reloaded', 'claude.reload']);
  });

  it('keeps both when the hook comes more than 3 s after the VM event', () => {
    const { bus, feed, clock, vmSuccess } = setup();
    vmSuccess();
    clock.now += RELOAD_MERGE_WINDOW_MS + 1;
    bus.emit('claude.reload', { ok: false, kind: 'hot-reload' });
    expect(reloads(feed).map((e) => e.kind)).toEqual(['app.reloaded', 'claude.reload']);
  });

  it('drops a VM "success" that comes up to 3 s after a successful hook result', () => {
    const { bus, feed, clock, vmSuccess } = setup();
    bus.emit('claude.reload', { ok: true, kind: 'hot-reload' });
    clock.now += RELOAD_MERGE_WINDOW_MS;
    vmSuccess();
    expect(reloads(feed).map((e) => e.kind)).toEqual(['claude.reload']);
    // A second VM event is another reload (the IDE's), so it shows.
    vmSuccess();
    expect(reloads(feed).map((e) => e.kind)).toEqual(['claude.reload', 'app.reloaded']);
  });

  it('keeps a VM "success" that comes more than 3 s after the hook result', () => {
    const { bus, feed, clock, vmSuccess } = setup();
    bus.emit('claude.reload', { ok: true, kind: 'hot-reload' });
    clock.now += RELOAD_MERGE_WINDOW_MS + 1;
    vmSuccess();
    expect(reloads(feed).map((e) => e.kind)).toEqual(['claude.reload', 'app.reloaded']);
  });

  it('only pairs a reload with a reload and a restart with a restart', () => {
    const { bus, feed, vmSuccess } = setup();
    vmSuccess('hot-restart');
    bus.emit('claude.reload', { ok: false, kind: 'hot-reload' });
    bus.emit('claude.reload', { ok: false, kind: 'hot-restart' });
    expect(reloads(feed).map((e) => (e.kind === 'claude.reload' ? e.reload : e.kind))).toEqual([
      'hot-restart',
      'hot-reload',
    ]);
  });

  it("never merges FlutterDeck's own reloads or failures", () => {
    const { bus, feed, app } = setup();
    bus.emit('app.reloaded', {
      appId: app.id,
      result: { ok: true, kind: 'hot-reload', durationMs: 12 },
    });
    bus.emit('app.reloaded', {
      appId: app.id,
      result: { ok: false, reason: 'compile-error', message: 'x', source: 'external' },
    });
    bus.emit('claude.reload', { ok: true, kind: 'hot-reload' });
    expect(reloads(feed).map((e) => e.kind)).toEqual([
      'app.reloaded',
      'app.reloaded',
      'claude.reload',
    ]);
  });

  it('pairs one VM event with one hook result only', () => {
    const { bus, feed, vmSuccess } = setup();
    vmSuccess();
    // The success is a duplicate of the VM row; the failure then finds no free VM row.
    bus.emit('claude.reload', { ok: true, kind: 'hot-reload' });
    bus.emit('claude.reload', { ok: false, kind: 'hot-reload' });
    expect(reloads(feed).map((e) => e.kind)).toEqual(['app.reloaded', 'claude.reload']);
  });

  it('never lets a failed hook result suppress a later VM success', () => {
    const { bus, feed, clock, vmSuccess } = setup();
    bus.emit('claude.reload', { ok: false, kind: 'hot-reload' });
    clock.now += 100;
    vmSuccess();
    expect(reloads(feed).map((e) => e.kind)).toEqual(['claude.reload', 'app.reloaded']);
  });

  it('C3 a failed hook result replaces an external VM failure from the 3 s before it', async () => {
    const { bus, feed, clock, app, pushed, flush } = setup();
    bus.emit('app.reloaded', {
      appId: app.id,
      result: { ok: false, reason: 'compile-error', message: 'x', source: 'external' },
    });
    const vm = feed.list().at(-1);
    clock.now += 1000;
    bus.emit('claude.reload', { ok: false, kind: 'hot-reload', message: 'Unable to reload' });
    await flush();
    const list = reloads(feed);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: vm?.id, kind: 'claude.reload', ok: false });
    // One failure, so one row: the dashboard and the notifier see the same id again.
    expect(new Set(pushed.filter((e) => e.kind !== 'app.attached').map((e) => e.id)).size).toBe(1);
  });

  it('C3 a successful hook result never pairs with a VM failure', () => {
    const { bus, feed, app } = setup();
    bus.emit('app.reloaded', {
      appId: app.id,
      result: { ok: false, reason: 'compile-error', message: 'x', source: 'external' },
    });
    bus.emit('claude.reload', { ok: true, kind: 'hot-reload' });
    expect(reloads(feed).map((e) => e.kind)).toEqual(['app.reloaded', 'claude.reload']);
  });

  it('C4 replaces the oldest unpaired VM event in the window, not a newer one', () => {
    const { bus, feed, clock, vmSuccess } = setup();
    // Claude's reload, then an IDE reload lands before Claude's hook result arrives.
    vmSuccess();
    const claudes = feed.list().at(-1);
    clock.now += 1000;
    vmSuccess();
    clock.now += 500;
    bus.emit('claude.reload', { ok: false, kind: 'hot-reload' });
    const list = reloads(feed);
    expect(list.map((e) => e.kind)).toEqual(['claude.reload', 'app.reloaded']);
    expect(list[0]?.id).toBe(claudes?.id);
  });

  it('C4 a successful hook result pairs with the oldest one too, leaving the IDE reload free', () => {
    const { bus, feed, clock, vmSuccess } = setup();
    vmSuccess();
    clock.now += 1000;
    vmSuccess();
    const ide = feed.list().at(-1);
    clock.now += 500;
    bus.emit('claude.reload', { ok: true, kind: 'hot-reload' });
    // A failure for the IDE's reload now finds the IDE row free.
    bus.emit('claude.reload', { ok: false, kind: 'hot-reload' });
    const list = reloads(feed);
    expect(list.map((e) => e.kind)).toEqual(['app.reloaded', 'claude.reload']);
    expect(list[1]?.id).toBe(ide?.id);
  });
});
