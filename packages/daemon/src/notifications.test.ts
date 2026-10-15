import type { DeckEvents } from '@project-deck/core';
import { DEFAULT_CONFIG, EventBus } from '@project-deck/core';
import { fakeApp } from '@project-deck/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ActivityFeed } from './activity.js';
import { NOTIFY_RATE_WINDOW_MS, startNotifications } from './notifications.js';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(settings = DEFAULT_CONFIG.notifications) {
  const bus = new EventBus<DeckEvents>();
  const clock = { now: 50_000 };
  new ActivityFeed(bus, { now: () => clock.now }).start();
  const notify = vi.fn<(title: string, text: string) => void>();
  const stop = startNotifications(bus, { settings, notify });
  const app = fakeApp({ name: 'shop_app' });
  bus.emit('app.attached', { app });
  const failReload = () =>
    bus.emit('app.reloaded', {
      appId: app.id,
      result: { ok: false, reason: 'compile-error', message: 'lib/main.dart:3: error' },
    });
  return { bus, clock, notify, stop, app, failReload };
}

describe('OS notifications', () => {
  it('tells about a crash with the UI copy, never with log content', async () => {
    const { bus, notify, app } = setup();
    bus.emit('app.exit', { appId: app.id, code: 1, crashed: true });
    await flush();
    expect(notify.mock.calls).toEqual([['FlutterDeck', 'App stopped — shop_app']]);
  });

  it('stays quiet when the app stops without a crash, when attached or when Claude finishes', async () => {
    const { bus, notify, app } = setup();
    bus.emit('app.exit', { appId: app.id, crashed: false });
    bus.emit('claude.done', { sessionId: 's' });
    await flush();
    expect(notify).not.toHaveBeenCalled();
  });

  it('tells about a failed reload without its error text', async () => {
    const { notify, failReload } = setup();
    failReload();
    await flush();
    expect(notify.mock.calls).toEqual([['FlutterDeck', 'Reload failed — shop_app']]);
  });

  it("tells about Claude's failed reload or restart, without the tool's message", async () => {
    const { bus, notify, clock } = setup();
    bus.emit('claude.reload', { ok: false, kind: 'hot-reload', message: 'Hot reload failed.' });
    clock.now += NOTIFY_RATE_WINDOW_MS;
    bus.emit('claude.reload', { ok: false, kind: 'hot-restart' });
    bus.emit('claude.reload', { ok: true, kind: 'hot-reload' });
    await flush();
    expect(notify.mock.calls).toEqual([
      ['FlutterDeck', 'Reload failed — shop_app'],
      ['FlutterDeck', 'Reload failed — shop_app'],
    ]);
  });

  it("tells when Claude's result replaces a VM success", async () => {
    const { bus, notify, app } = setup();
    bus.emit('app.reloaded', {
      appId: app.id,
      result: { ok: true, kind: 'hot-reload', source: 'external' },
    });
    bus.emit('claude.reload', { ok: false, kind: 'hot-reload' });
    await flush();
    expect(notify.mock.calls).toEqual([['FlutterDeck', 'Reload failed — shop_app']]);
  });

  it('says "Reload failed" alone when no app is attached', async () => {
    const { bus, notify, app } = setup();
    bus.emit('app.detached', { appId: app.id });
    bus.emit('claude.reload', { ok: false, kind: 'hot-reload' });
    await flush();
    expect(notify.mock.calls).toEqual([['FlutterDeck', 'Reload failed']]);
  });

  it('skips reloads that never ran: no app attached, or the app cannot reload', async () => {
    const { bus, notify, app } = setup();
    for (const reason of ['not-attached', 'unsupported'] as const) {
      bus.emit('app.reloaded', { appId: app.id, result: { ok: false, reason, message: 'x' } });
    }
    await flush();
    expect(notify).not.toHaveBeenCalled();
  });

  it("tells when Claude is waiting, with the first 100 characters of Claude Code's message", async () => {
    const { bus, notify, clock } = setup();
    bus.emit('claude.waiting', {
      message: `Claude needs your permission to use Bash ${'x'.repeat(200)}`,
    });
    clock.now += NOTIFY_RATE_WINDOW_MS;
    bus.emit('claude.waiting', {});
    await flush();
    const [first, second] = notify.mock.calls;
    expect(first?.[1]).toBe(
      `Claude is waiting — ${`Claude needs your permission to use Bash ${'x'.repeat(200)}`.slice(0, 100)}`,
    );
    expect(second).toEqual(['FlutterDeck', 'Claude is waiting']);
  });

  it('honours each switch in config', async () => {
    const { bus, notify, failReload, app } = setup({
      appCrashed: false,
      reloadFailed: false,
      claudeWaiting: false,
    });
    failReload();
    bus.emit('claude.reload', { ok: false, kind: 'hot-reload' });
    bus.emit('claude.waiting', { message: 'Allow?' });
    bus.emit('app.exit', { appId: app.id, crashed: true });
    await flush();
    expect(notify).not.toHaveBeenCalled();
  });

  it('sends one per kind per 30 s and counts the rest in the next one', async () => {
    const { bus, notify, failReload, clock } = setup();
    failReload();
    clock.now += 1000;
    failReload();
    failReload();
    bus.emit('claude.waiting', { message: 'Allow?' });
    clock.now += NOTIFY_RATE_WINDOW_MS - 1000 - 1;
    failReload();
    await flush();
    expect(notify.mock.calls).toEqual([
      ['FlutterDeck', 'Reload failed — shop_app'],
      ['FlutterDeck', 'Claude is waiting — Allow?'],
    ]);
    clock.now += 1;
    failReload();
    await flush();
    expect(notify.mock.calls.at(-1)).toEqual(['FlutterDeck', 'Reload failed (4 times) — shop_app']);
    clock.now += NOTIFY_RATE_WINDOW_MS;
    failReload();
    await flush();
    expect(notify.mock.calls.at(-1)).toEqual(['FlutterDeck', 'Reload failed — shop_app']);
  });

  it('stops listening', async () => {
    const { notify, failReload, stop } = setup();
    stop();
    failReload();
    await flush();
    expect(notify).not.toHaveBeenCalled();
  });

  it('survives a notifier that throws', async () => {
    const { notify, failReload, clock } = setup();
    notify.mockImplementation(() => {
      throw new Error('boom');
    });
    failReload();
    clock.now += NOTIFY_RATE_WINDOW_MS;
    failReload();
    await flush();
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
