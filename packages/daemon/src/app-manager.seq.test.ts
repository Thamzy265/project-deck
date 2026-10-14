import type { DeckEvents, LogEntry } from '@project-deck/core';
import { EventBus, Registry } from '@project-deck/core';
import { FakeAppConnector, fakeApp } from '@project-deck/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { AppManager } from './app-manager.js';

const entry = (message: string, ts: number): LogEntry => ({
  ts,
  level: 'info',
  source: 'app',
  message,
});

/**
 * Review C2: the dashboard can't order lines by their own time (the device clock may be
 * off), so the daemon numbers each line as it takes it in.
 */
describe('AppManager log sequence numbers', () => {
  it('numbers backfill, live lines and re-attached apps in arrival order', async () => {
    const registry = new Registry();
    const connector = new FakeAppConnector('fake', [fakeApp()]);
    registry.connectors.register(connector);
    const bus = new EventBus<DeckEvents>();
    const live: LogEntry[] = [];
    bus.on('app.log', ({ entry: e }) => live.push(e));
    const manager = new AppManager(registry, bus);

    // Logged before the attach: the backfill. Device times run backwards on purpose.
    const first = await connector.attach('app-1');
    first.logs().push(entry('old', 900));
    await manager.start();
    await vi.waitFor(() => expect(manager.attachedApp()).toBeDefined());
    connector.sessions.get('app-1')?.logs().push(entry('live', 100));

    const stored = (await manager.logs()?.query({})) ?? [];
    expect(stored.map((e) => [e.message, e.seq])).toEqual([
      ['old', 0],
      ['live', 1],
    ]);
    expect(live.map((e) => e.seq)).toEqual([1]);

    // A new attach keeps counting, so lines from two apps never share a number.
    connector.removeApp('app-1');
    await vi.waitFor(() => expect(manager.attachedApp()).toBeUndefined());
    connector.addApp(fakeApp());
    await vi.waitFor(() => expect(manager.attachedApp()).toBeDefined());
    connector.sessions.get('app-1')?.logs().push(entry('again', 50));
    expect(live.at(-1)).toMatchObject({ message: 'again', seq: 2 });
    await manager.stop();
  });
});
