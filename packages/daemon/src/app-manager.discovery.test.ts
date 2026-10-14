import type { DeckEvents } from '@project-deck/core';
import { EventBus, Registry } from '@project-deck/core';
import { FakeAppConnector, fakeApp } from '@project-deck/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { AppManager, DISCOVERY_BOUND_MS } from './app-manager.js';

/** A connector whose start() waits until the test lets it finish. */
class SlowConnector extends FakeAppConnector {
  finish: () => void = () => undefined;
  override start(): Promise<void> {
    return new Promise((resolve) => (this.finish = resolve));
  }
}

class BrokenConnector extends FakeAppConnector {
  override start(): Promise<void> {
    return Promise.reject(new Error('no DTD'));
  }
}

function setup(...connectors: FakeAppConnector[]) {
  const registry = new Registry();
  for (const c of connectors) registry.connectors.register(c);
  const bus = new EventBus<DeckEvents>();
  const seen: boolean[] = [];
  bus.on('apps.discovering', ({ discovering }) => seen.push(discovering));
  return { manager: new AppManager(registry, bus, { onConnectorError: () => undefined }), seen };
}

describe('AppManager discovery state', () => {
  it('is discovering until every connector has finished starting', async () => {
    const slow = new SlowConnector('slow', []);
    const { manager, seen } = setup(new FakeAppConnector('fast', [fakeApp()]), slow);
    expect(manager.discovering()).toBe(true);
    const started = manager.start();
    await Promise.resolve();
    expect(manager.discovering()).toBe(true);
    slow.finish();
    await started;
    expect(manager.discovering()).toBe(false);
    expect(seen).toEqual([false]);
  });

  it('stops discovering when a connector fails to start', async () => {
    const { manager, seen } = setup(new BrokenConnector('broken', []));
    await manager.start();
    expect(manager.discovering()).toBe(false);
    expect(seen).toEqual([false]);
  });

  it('stops discovering after the bound even if a connector never finishes (review C6)', async () => {
    vi.useFakeTimers();
    try {
      const slow = new SlowConnector('slow', []);
      const { manager, seen } = setup(slow);
      void manager.start();
      await vi.advanceTimersByTimeAsync(DISCOVERY_BOUND_MS - 1);
      expect(manager.discovering()).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(manager.discovering()).toBe(false);
      expect(seen).toEqual([false]);
      // The connector finishing later doesn't announce it again.
      slow.finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toEqual([false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is done at once with no connectors', async () => {
    const { manager } = setup();
    await manager.start();
    expect(manager.discovering()).toBe(false);
  });
});
