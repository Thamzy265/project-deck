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

  it("opens log feeds with the session's app, which knows more than the listing", async () => {
    const registry = new Registry();
    const connector = new FakeAppConnector('fake', [fakeApp()]);
    registry.connectors.register(connector);
    const attach = connector.attach.bind(connector);
    // Like DartAppSession: the pid is only known once the VM service has been read.
    vi.spyOn(connector, 'attach').mockImplementation(async (id) => {
      const session = await attach(id);
      Object.defineProperty(session, 'app', { value: { ...session.app, pid: 4242 } });
      return session;
    });
    const opened: unknown[] = [];
    registry.logFeeds.register({
      id: 'native',
      open: (app) => {
        opened.push(app);
        return Promise.resolve(undefined);
      },
    });
    const manager = new AppManager(registry, new EventBus());
    await manager.start();
    await vi.waitFor(() => expect(opened).toEqual([{ ...fakeApp(), pid: 4242 }]));
    expect(manager.attachedApp()?.pid).toBe(4242);
    await manager.stop();
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

  it('keeps log entries that arrive while backfilling', async () => {
    const registry = new Registry();
    // Two apps, so nothing auto-attaches before the test is set up.
    const connector = new FakeAppConnector('fake', [fakeApp(), fakeApp({ id: 'app-2' })]);
    registry.connectors.register(connector);
    const manager = new AppManager(registry, new EventBus());
    await manager.start();
    const source = (await connector.attach('app-1')).logs();
    source.push(entry('before attach'));
    const query = source.query.bind(source);
    source.query = async (q) => {
      const result = await query(q);
      source.push(entry('during backfill'));
      return result;
    };

    await manager.attach('app-1');
    source.push(entry('after attach'));
    expect((await manager.logs()?.query({}))?.map((e) => e.message)).toEqual([
      'before attach',
      'during backfill',
      'after attach',
    ]);
  });

  it('detaches the session when the app exits', async () => {
    const { connector } = await setup();
    const session = connector.sessions.get('app-1');
    connector.removeApp('app-1');
    await vi.waitFor(() => expect(session?.detached).toBe(true));
  });

  it('ignores a connector that finishes starting after stop', async () => {
    const registry = new Registry();
    const connector = new FakeAppConnector('slow', [fakeApp()]);
    let finishStart = (): void => undefined;
    connector.start = () =>
      new Promise<void>((resolve) => {
        finishStart = resolve;
      });
    registry.connectors.register(connector);
    const manager = new AppManager(registry, new EventBus());
    const starting = manager.start();
    await manager.stop();
    finishStart();
    await starting;
    connector.addApp(fakeApp({ id: 'app-2' }));
    await new Promise((r) => setTimeout(r, 10));
    expect(manager.apps()).toEqual([]);
    expect(connector.sessions.size).toBe(0);
  });
  it('B5: lists apps a connector reports before its start() resolves', async () => {
    const registry = new Registry();
    const connector = new FakeAppConnector('slow');
    let finishStart = (): void => undefined;
    connector.start = () =>
      new Promise<void>((resolve) => {
        finishStart = resolve;
      });
    registry.connectors.register(connector);
    const bus = new EventBus<DeckEvents>();
    const changed = vi.fn();
    bus.on('apps.changed', changed);
    const manager = new AppManager(registry, bus);
    const starting = manager.start();
    // A DTD that connected early, while slower ones in the same first scan are still pending.
    connector.addApp(fakeApp());
    expect(manager.apps().map((a) => a.id)).toEqual(['app-1']);
    expect(changed).toHaveBeenCalled();
    finishStart();
    await starting;
    expect(manager.apps().map((a) => a.id)).toEqual(['app-1']);
    await manager.stop();
  });

  it('drops apps reported by a connector whose start() then fails', async () => {
    const registry = new Registry();
    const connector = new FakeAppConnector('flaky', [fakeApp(), fakeApp({ id: 'app-2' })]);
    let failStart = (): void => undefined;
    connector.start = () =>
      new Promise<void>((_resolve, reject) => {
        failStart = () => reject(new Error('DTD unreachable'));
      });
    registry.connectors.register(connector);
    const onConnectorError = vi.fn();
    const manager = new AppManager(registry, new EventBus(), { onConnectorError });
    const starting = manager.start();
    connector.addApp(fakeApp({ id: 'app-3' }));
    failStart();
    await starting;
    expect(onConnectorError).toHaveBeenCalledWith('flaky', expect.any(Error));
    expect(manager.apps()).toEqual([]);
    connector.addApp(fakeApp({ id: 'app-4' }));
    expect(manager.apps()).toEqual([]);
  });
  it('detaches an app auto-attached from a connector whose start() then fails', async () => {
    const registry = new Registry();
    const connector = new FakeAppConnector('flaky');
    let failStart = (): void => undefined;
    connector.start = () =>
      new Promise<void>((_resolve, reject) => {
        failStart = () => reject(new Error('DTD unreachable'));
      });
    registry.connectors.register(connector);
    const manager = new AppManager(registry, new EventBus());
    const starting = manager.start();
    connector.addApp(fakeApp());
    await vi.waitFor(() => expect(manager.attachedApp()).toBeDefined());
    failStart();
    await starting;
    await vi.waitFor(() => expect(connector.sessions.get('app-1')?.detached).toBe(true));
    expect(manager.attachedApp()).toBeUndefined();
  });
});
