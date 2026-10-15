/**
 * Tester edge cases for the 3 s merge of Claude's reload hook with the VM's reload events:
 * the exact window edges, two reloads close together, hook-first ordering and capacity.
 */
import type { ActivityEntry, DeckEvents } from '@project-deck/core';
import { ActivityEntrySchema, EventBus } from '@project-deck/core';
import { fakeApp } from '@project-deck/core/testing';
import { describe, expect, it } from 'vitest';
import { ActivityFeed, RELOAD_MERGE_WINDOW_MS } from './activity.js';

function setup(capacity?: number) {
  const bus = new EventBus<DeckEvents>();
  const clock = { now: 100_000 };
  const feed = new ActivityFeed(bus, {
    now: () => clock.now,
    ...(capacity === undefined ? {} : { capacity }),
  });
  const pushed: ActivityEntry[] = [];
  bus.on('activity', (entry) => pushed.push(entry));
  feed.start();
  const app = fakeApp({ name: 'shop_app' });
  bus.emit('app.attached', { app });
  const vm = (kind: 'hot-reload' | 'hot-restart' = 'hot-reload') =>
    bus.emit('app.reloaded', { appId: app.id, result: { ok: true, kind, source: 'external' } });
  const hook = (ok: boolean, kind: 'hot-reload' | 'hot-restart' = 'hot-reload') =>
    bus.emit('claude.reload', { ok, kind, ...(ok ? {} : { message: 'Hot reload failed.' }) });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  return { bus, feed, clock, pushed, app, vm, hook, flush };
}

/** Each reload row as "<kind>:<ok or source>@<ts>". */
const rows = (feed: ActivityFeed) =>
  feed
    .list()
    .filter((e) => e.kind === 'app.reloaded' || e.kind === 'claude.reload')
    .map((e) =>
      e.kind === 'claude.reload'
        ? `claude:${e.ok ? 'ok' : 'failed'}@${e.ts}`
        : `vm:${e.result.ok ? (e.result.source ?? 'own') : 'failed'}@${e.ts}`,
    );

describe('reload merge window edges', () => {
  it('merges a hook exactly 3 s after the VM event, not 1 ms later', () => {
    const a = setup();
    a.vm();
    a.clock.now += RELOAD_MERGE_WINDOW_MS;
    a.hook(false);
    expect(rows(a.feed)).toEqual(['claude:failed@100000']);

    const b = setup();
    b.vm();
    b.clock.now += RELOAD_MERGE_WINDOW_MS + 1;
    b.hook(false);
    expect(rows(b.feed)).toEqual(['vm:external@100000', 'claude:failed@103001']);
  });

  it('drops a VM event exactly 3 s after the hook, keeps one 1 ms later', () => {
    const a = setup();
    a.hook(true);
    a.clock.now += RELOAD_MERGE_WINDOW_MS;
    a.vm();
    expect(rows(a.feed)).toEqual(['claude:ok@100000']);

    const b = setup();
    b.hook(true);
    b.clock.now += RELOAD_MERGE_WINDOW_MS + 1;
    b.vm();
    expect(rows(b.feed)).toEqual(['claude:ok@100000', 'vm:external@103001']);
  });

  it('pairs two reloads 1 s apart one to one (VM first each time)', async () => {
    const { feed, clock, vm, hook, pushed, flush } = setup();
    vm();
    clock.now += 200;
    hook(false);
    clock.now += 800;
    vm();
    clock.now += 200;
    hook(true);
    // The failure replaces its VM row; the success is a duplicate of its VM row.
    expect(rows(feed)).toEqual(['claude:failed@100000', 'vm:external@101000']);
    await flush();
    // The replacement is announced again under the id of the row it replaced.
    const ids = feed.list().map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const replaced = pushed.filter((e) => e.kind === 'claude.reload');
    expect(replaced.map((e) => ids.includes(e.id))).toEqual([true]);
  });

  it('pairs two hooks that both come before their VM events', () => {
    const { feed, clock, vm, hook } = setup();
    hook(false);
    clock.now += 100;
    hook(true);
    clock.now += 100;
    vm();
    clock.now += 100;
    vm();
    clock.now += 100;
    // A third VM event has no hook left to pair with: it stays.
    vm();
    // Only the successful hook absorbs a later VM event; a failure never does.
    expect(rows(feed)).toEqual([
      'claude:failed@100000',
      'claude:ok@100100',
      'vm:external@100300',
      'vm:external@100400',
    ]);
  });

  it('never pairs a restart hook with a reload event, in either order', () => {
    const { feed, clock, vm, hook } = setup();
    hook(true, 'hot-restart');
    clock.now += 100;
    vm('hot-reload');
    clock.now += 100;
    hook(true, 'hot-reload');
    // The reload hook is a duplicate of the reload VM event, never of the restart hook.
    expect(rows(feed)).toEqual(['claude:ok@100000', 'vm:external@100100']);
    expect(feed.list().flatMap((e) => (e.kind === 'claude.reload' ? [e.reload] : []))).toEqual([
      'hot-restart',
    ]);
  });

  it('adds a new row when the VM row has already left a full feed', () => {
    const { bus, feed, clock, vm, hook } = setup(2);
    vm();
    bus.emit('claude.done', {});
    bus.emit('claude.done', {});
    clock.now += 100;
    hook(false);
    expect(feed.list().map((e) => e.kind)).toEqual(['claude.done', 'claude.reload']);
  });

  it('keeps every merged row valid for the shared schema', () => {
    const { feed, clock, vm, hook } = setup();
    vm();
    clock.now += 10;
    hook(false);
    for (const entry of feed.list()) expect(ActivityEntrySchema.parse(entry)).toEqual(entry);
  });

  it('leaves the app out when it was detached before the hook result arrived', () => {
    const { bus, feed, clock, vm, app } = setup();
    vm();
    bus.emit('app.detached', { appId: app.id });
    clock.now += 100;
    bus.emit('claude.reload', { ok: false, kind: 'hot-reload' });
    const [row] = feed.list().filter((e) => e.kind === 'claude.reload');
    expect(row).toMatchObject({ kind: 'claude.reload', ok: false });
    expect(row).not.toHaveProperty('appId');
  });

  // T-P5-6 (fixed, lead decision 15 Oct 2026): a failed hook never suppresses a later VM
  // event; a compile failure posts no VM event, so the next one is someone else's reload.
  it("T-P5-6 keeps an IDE reload that follows Claude's compile failure within 3 s", () => {
    const { feed, clock, vm, hook } = setup();
    hook(false);
    clock.now += 1500;
    vm();
    expect(rows(feed)).toEqual(['claude:failed@100000', 'vm:external@101500']);
  });

  // T-P5-7 (lead decision 15 Oct 2026): a FAILED hook replaces a VM success only from the
  // 3 s before it (the VM-rejection case, which can't be told from an IDE reload then), and
  // never suppresses a later VM event, which is shown on its own.
  it('T-P5-7 a failed hook replaces the VM success just before it and keeps later ones', () => {
    const { feed, clock, vm, hook } = setup();
    vm();
    clock.now += 2000;
    hook(false);
    clock.now += 100;
    vm();
    expect(rows(feed)).toEqual(['claude:failed@100000', 'vm:external@102100']);
  });

  // T-P5-7: a SUCCESSFUL hook never replaces an earlier IDE reload; with a VM success of
  // the same kind within 3 s before it, it is a duplicate and adds nothing.
  it('T-P5-7 a successful hook never replaces an earlier VM row', async () => {
    const { feed, clock, vm, hook, pushed, flush } = setup();
    vm();
    clock.now += 2000;
    hook(true);
    clock.now += 100;
    vm();
    expect(rows(feed)).toEqual(['vm:external@100000', 'vm:external@102100']);
    await flush();
    expect(pushed.filter((e) => e.kind === 'claude.reload')).toEqual([]);
  });

  it('T-P5-7 a successful hook with no VM row before it absorbs the next VM success only', () => {
    const { feed, clock, vm, hook } = setup();
    hook(true);
    clock.now += 100;
    vm();
    clock.now += 100;
    vm();
    expect(rows(feed)).toEqual(['claude:ok@100000', 'vm:external@100200']);
  });
});
