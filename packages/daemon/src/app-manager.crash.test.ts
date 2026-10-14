import type { DeckEvents, LogFeedFactory } from '@project-deck/core';
import { EventBus, Registry } from '@project-deck/core';
import { FakeAppConnector, fakeApp } from '@project-deck/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { AppManager, CRASH_WINDOW_MS } from './app-manager.js';

async function setup(feed?: LogFeedFactory) {
  const registry = new Registry();
  const connector = new FakeAppConnector('fake', [fakeApp()]);
  registry.connectors.register(connector);
  if (feed !== undefined) registry.logFeeds.register(feed);
  const bus = new EventBus<DeckEvents>();
  const exits: DeckEvents['app.exit'][] = [];
  bus.on('app.exit', (e) => exits.push(e));
  let clock = 1_000_000;
  const manager = new AppManager(registry, bus, { now: () => clock });
  await manager.start();
  await vi.waitFor(() => expect(manager.attachedApp()).toBeDefined());
  const session = connector.sessions.get('app-1');
  if (session === undefined) throw new Error('not attached');
  const advance = (ms: number) => (clock += ms);
  const exited = () => vi.waitFor(() => expect(exits).toHaveLength(1));
  return { manager, session, exits, advance, exited };
}

describe('AppManager: stopped or crashed', () => {
  it('uses a 5 s window', () => {
    expect(CRASH_WINDOW_MS).toBe(5000);
  });

  it('calls an exit with no error log line just before a stop', async () => {
    const { session, exits, exited } = await setup();
    session.logs().push({ ts: 1, level: 'info', source: 'app', message: 'bye' });
    session.simulateExit(0);
    await exited();
    expect(exits[0]).toEqual({ appId: 'app-1', code: 0, crashed: false });
  });

  it('calls an exit within 5 s of an error log line a crash', async () => {
    const { session, exits, advance, exited } = await setup();
    session.logs().push({ ts: 1, level: 'error', source: 'app', message: 'Unhandled exception' });
    advance(CRASH_WINDOW_MS);
    session.simulateExit();
    await exited();
    expect(exits[0]).toEqual({ appId: 'app-1', crashed: true });
  });

  it('counts fatal native lines from a log feed too', async () => {
    let push: ((e: Parameters<Parameters<LogFeedFactory['open']>[1]>[0]) => void) | undefined;
    const feed: LogFeedFactory = {
      id: 'native',
      open: (_app, cb) => {
        push = cb;
        return Promise.resolve(() => Promise.resolve());
      },
    };
    const { session, exits, exited } = await setup(feed);
    await vi.waitFor(() => expect(push).toBeDefined());
    push?.({ ts: 1, level: 'fatal', source: 'native', message: 'SIGSEGV' });
    session.simulateExit();
    await exited();
    expect(exits[0]?.crashed).toBe(true);
  });

  it('calls an exit more than 5 s after the last error a stop', async () => {
    const { session, exits, advance, exited } = await setup();
    session.logs().push({ ts: 1, level: 'error', source: 'app', message: 'old error' });
    advance(CRASH_WINDOW_MS + 1);
    session.simulateExit();
    await exited();
    expect(exits[0]?.crashed).toBe(false);
  });

  it('never reports an exit when FlutterDeck detaches', async () => {
    const { manager, session, exits } = await setup();
    session.logs().push({ ts: 1, level: 'error', source: 'app', message: 'boom' });
    await manager.detach();
    session.simulateExit();
    await new Promise((r) => setTimeout(r, 10));
    expect(exits).toEqual([]);
  });
});
