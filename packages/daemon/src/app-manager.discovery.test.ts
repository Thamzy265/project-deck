import type { DeckEvents } from '@project-deck/core';
import { EventBus, Registry } from '@project-deck/core';
import { FakeAppConnector, fakeApp } from '@project-deck/core/testing';
import { describe, expect, it } from 'vitest';
import { AppManager } from './app-manager.js';

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

  it('is done at once with no connectors', async () => {
    const { manager } = setup();
    await manager.start();
    expect(manager.discovering()).toBe(false);
  });
});
