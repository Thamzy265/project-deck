import type { DeckEvents, LogEntry, LogFeedFactory } from '@project-deck/core';
import { EventBus, Registry } from '@project-deck/core';
import { FakeAppConnector, fakeApp } from '@project-deck/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { AppManager, CRASH_WINDOW_MS } from './app-manager.js';

interface Setup {
  manager: AppManager;
  connector: FakeAppConnector;
  exits: DeckEvents['app.exit'][];
  detached: DeckEvents['app.detached'][];
  advance: (ms: number) => void;
  pushNative: (entry: LogEntry) => void;
}

async function setup(opts: { before?: (c: FakeAppConnector) => Promise<void> } = {}) {
  const registry = new Registry();
  const connector = new FakeAppConnector('fake', [fakeApp()]);
  registry.connectors.register(connector);
  let native: ((entry: LogEntry) => void) | undefined;
  const feed: LogFeedFactory = {
    id: 'native',
    open: (_app, cb) => {
      native = cb;
      return Promise.resolve(() => Promise.resolve());
    },
  };
  registry.logFeeds.register(feed);
  await opts.before?.(connector);
  const bus = new EventBus<DeckEvents>();
  const exits: DeckEvents['app.exit'][] = [];
  const detached: DeckEvents['app.detached'][] = [];
  bus.on('app.exit', (e) => exits.push(e));
  bus.on('app.detached', (e) => detached.push(e));
  let clock = 5_000_000;
  const manager = new AppManager(registry, bus, { now: () => clock });
  await manager.start();
  await vi.waitFor(() => expect(manager.attachedApp()).toBeDefined());
  await vi.waitFor(() => expect(native).toBeDefined());
  const result: Setup = {
    manager,
    connector,
    exits,
    detached,
    advance: (ms) => (clock += ms),
    pushNative: (entry) => native?.(entry),
  };
  return result;
}

function session(s: Setup) {
  const live = s.connector.sessions.get('app-1');
  if (live === undefined) throw new Error('no session');
  return live;
}

const settle = () => new Promise((r) => setTimeout(r, 20));
/** Device time of a line logged after the attach; the fake clock starts at 5_000_000. */
const LIVE_TS = 9_000_000;
const line = (level: LogEntry['level'], source: LogEntry['source'] = 'app'): LogEntry => ({
  ts: LIVE_TS,
  level,
  source,
  message: `${level} line`,
});

describe('AppManager crash rule: boundaries', () => {
  it('calls a native fatal line exactly 5 s before the exit a crash, and 5 s + 1 ms a stop', async () => {
    const at = await setup();
    at.pushNative(line('fatal', 'native'));
    at.advance(CRASH_WINDOW_MS);
    session(at).simulateExit();
    await vi.waitFor(() => expect(at.exits).toHaveLength(1));
    expect(at.exits[0]?.crashed).toBe(true);

    const after = await setup();
    after.pushNative(line('error', 'native'));
    after.advance(CRASH_WINDOW_MS + 1);
    session(after).simulateExit();
    await vi.waitFor(() => expect(after.exits).toHaveLength(1));
    expect(after.exits[0]?.crashed).toBe(false);
  });

  it('measures from the last error, not the first', async () => {
    const s = await setup();
    session(s).logs().push(line('error'));
    s.advance(CRASH_WINDOW_MS * 2);
    s.pushNative(line('error', 'native'));
    s.advance(CRASH_WINDOW_MS - 1);
    session(s).simulateExit(1);
    await vi.waitFor(() => expect(s.exits).toHaveLength(1));
    expect(s.exits[0]).toEqual({ appId: 'app-1', code: 1, crashed: true });
  });

  it('is not reset by info lines after the error', async () => {
    const s = await setup();
    session(s).logs().push(line('error'));
    for (let i = 0; i < 20; i++) session(s).logs().push(line('info'));
    s.advance(1000);
    session(s).simulateExit();
    await vi.waitFor(() => expect(s.exits).toHaveLength(1));
    expect(s.exits[0]?.crashed).toBe(true);
  });

  it('does not count a warning as a crash', async () => {
    const s = await setup();
    session(s).logs().push(line('warn'));
    s.pushNative(line('warn', 'native'));
    session(s).simulateExit();
    await vi.waitFor(() => expect(s.exits).toHaveLength(1));
    expect(s.exits[0]?.crashed).toBe(false);
  });

  it('does not count an error from before the attach (the backfill)', async () => {
    const s = await setup({
      before: async (connector) => {
        const early = await connector.attach('app-1');
        early.logs().push(line('error'));
      },
    });
    // The error is in the buffer the dashboard reads, but it came in before the attach.
    expect(await s.manager.logs()?.query({ minLevel: 'error' })).toHaveLength(1);
    session(s).simulateExit();
    await vi.waitFor(() => expect(s.exits).toHaveLength(1));
    expect(s.exits[0]?.crashed).toBe(false);
  });

  it('forgets errors from an earlier attach of the same app', async () => {
    const s = await setup();
    session(s).logs().push(line('error'));
    await s.manager.detach();
    await s.manager.attach('app-1');
    session(s).simulateExit();
    await vi.waitFor(() => expect(s.exits).toHaveLength(1));
    expect(s.exits[0]?.crashed).toBe(false);
  });
});

describe('AppManager crash rule: races', () => {
  it('reports nothing for an exit that races a detach started first', async () => {
    const s = await setup();
    const live = session(s);
    live.logs().push(line('error'));
    const detaching = s.manager.detach();
    live.simulateExit(1);
    await detaching;
    await settle();
    expect(s.exits).toEqual([]);
    expect(s.detached).toHaveLength(1);
  });

  it('reports one exit and no detach when the exit comes just before a detach', async () => {
    const s = await setup();
    const live = session(s);
    live.logs().push(line('error'));
    live.simulateExit(1);
    await s.manager.detach();
    await settle();
    expect(s.exits).toEqual([{ appId: 'app-1', code: 1, crashed: true }]);
    expect(s.detached).toEqual([]);
  });

  it('reports a repeated exit event only once', async () => {
    const s = await setup();
    const live = session(s);
    live.simulateExit(0);
    live.simulateExit(0);
    live.simulateExit(1);
    await settle();
    expect(s.exits).toHaveLength(1);
  });

  it('ignores error lines that arrive after the exit was handled', async () => {
    const s = await setup();
    const live = session(s);
    live.simulateExit();
    await vi.waitFor(() => expect(s.exits).toHaveLength(1));
    s.pushNative(line('fatal', 'native'));
    live.simulateExit();
    await settle();
    expect(s.exits).toEqual([{ appId: 'app-1', crashed: false }]);
  });
});
