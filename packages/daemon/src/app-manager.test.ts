import type { DeckEvents, LogEntry, LogFeedFactory } from '@project-deck/core';
import { EventBus, Registry } from '@project-deck/core';
import { FakeAppConnector, fakeApp } from '@project-deck/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { AppManager, UnknownAppError } from './app-manager.js';

const entry = (message: string, overrides: Partial<LogEntry> = {}): LogEntry => ({
  ts: Date.now(),
  level: 'info',
  source: 'app',
  message,
  ...overrides,
});

async function setup(apps = [fakeApp()]) {
  const registry = new Registry();
  const connector = new FakeAppConnector('fake', apps);
  registry.connectors.register(connector);
  const bus = new EventBus<DeckEvents>();
  const events: [keyof DeckEvents, unknown][] = [];
  bus.onAny((type, payload) => events.push([type, payload]));
  const manager = new AppManager(registry, bus);
  await manager.start();
  // Auto-attach is queued; let it settle.
  await vi.waitFor(() => {
    if (apps.length === 1) expect(manager.attachedApp()).toBeDefined();
  });
  return { registry, connector, bus, events, manager };
}

describe('AppManager', () => {
  it('auto-attaches when exactly one app is running', async () => {
    const { manager, events } = await setup();
    expect(manager.attachedApp()?.id).toBe('app-1');
    expect(events.map(([t]) => t)).toEqual(['apps.changed', 'app.attached']);
  });

  it('does not auto-attach when several apps are running', async () => {
    const { manager } = await setup([fakeApp(), fakeApp({ id: 'app-2' })]);
    expect(manager.attachedApp()).toBeUndefined();
    await manager.attach('app-2');
    expect(manager.attachedApp()?.id).toBe('app-2');
  });

  it('rejects unknown apps', async () => {
    const { manager } = await setup();
    await expect(manager.attach('nope')).rejects.toBeInstanceOf(UnknownAppError);
  });

  it('forwards reloads and reports not-attached without a session', async () => {
    const { manager, connector, events } = await setup();
    connector.sessions
      .get('app-1')
      ?.nextReload({ ok: false, reason: 'compile-error', message: 'x' });
    expect(await manager.reload()).toMatchObject({ reason: 'compile-error' });
    expect(events.at(-1)?.[0]).toBe('app.reloaded');

    await manager.detach();
    expect(await manager.restart()).toMatchObject({ ok: false, reason: 'not-attached' });
    expect(connector.sessions.get('app-1')?.detached).toBe(true);
  });

  it('merges session logs and log feeds into one buffer', async () => {
    const registry = new Registry();
    const connector = new FakeAppConnector('fake', [fakeApp()]);
    registry.connectors.register(connector);
    let emitNative: ((e: LogEntry) => void) | undefined;
    const close = vi.fn(() => Promise.resolve());
    const feed: LogFeedFactory = {
      id: 'native',
      open: (_app, onEntry) => {
        emitNative = onEntry;
        return Promise.resolve(close);
      },
    };
    registry.logFeeds.register(feed);
    const skipped: LogFeedFactory = { id: 'skipped', open: () => Promise.resolve(undefined) };
    registry.logFeeds.register(skipped);
    const manager = new AppManager(registry, new EventBus());
    await manager.start();
    await vi.waitFor(() => expect(emitNative).toBeDefined());

    connector.sessions.get('app-1')?.logs().push(entry('from dart'));
    emitNative?.(entry('from logcat', { source: 'native' }));
    const logs = await manager.logs()?.query({});
    expect(logs?.map((e) => e.message)).toEqual(['from dart', 'from logcat']);

    await manager.detach();
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps logs after the app exits and re-attaches when it comes back', async () => {
    const { manager, connector, events } = await setup();
    connector.sessions.get('app-1')?.logs().push(entry('before exit'));
    connector.removeApp('app-1');
    await vi.waitFor(() => expect(manager.attachedApp()).toBeUndefined());
    expect(events.some(([t]) => t === 'app.exit')).toBe(true);
    expect((await manager.logs()?.query({}))?.map((e) => e.message)).toEqual(['before exit']);

    connector.addApp(fakeApp());
    await vi.waitFor(() => expect(manager.attachedApp()?.id).toBe('app-1'));
  });

  it('does not re-attach after the user detaches', async () => {
    const { manager, connector } = await setup();
    await manager.detach();
    connector.addApp(fakeApp());
    await new Promise((r) => setTimeout(r, 10));
    expect(manager.attachedApp()).toBeUndefined();
  });

  it('keeps running when a connector fails to start', async () => {
    const registry = new Registry();
    const broken = new FakeAppConnector('broken');
    broken.start = () => Promise.reject(new Error('DTD unreachable'));
    registry.connectors.register(broken);
    const onConnectorError = vi.fn();
    const manager = new AppManager(registry, new EventBus(), { onConnectorError });
    await manager.start();
    expect(onConnectorError).toHaveBeenCalledWith('broken', expect.any(Error));
    expect(manager.apps()).toEqual([]);
  });
});
