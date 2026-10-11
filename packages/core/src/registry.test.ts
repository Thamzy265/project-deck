import { describe, expect, it, vi } from 'vitest';
import { EventBus } from './events.js';
import { Registry } from './registry.js';
import { FakeAppConnector, FakeTaskProvider } from './testing/index.js';

describe('Registry', () => {
  it('registers, looks up and unregisters by id', () => {
    const registry = new Registry();
    const connector = new FakeAppConnector('dart');
    const off = registry.connectors.register(connector);

    expect(registry.connectors.get('dart')).toBe(connector);
    expect(registry.connectors.require('dart')).toBe(connector);
    expect(registry.connectors.list()).toEqual([connector]);

    off();
    expect(registry.connectors.get('dart')).toBeUndefined();
    expect(() => registry.connectors.require('dart')).toThrow(/No connector/);
  });

  it('rejects duplicate ids', () => {
    const registry = new Registry();
    registry.taskProviders.register(new FakeTaskProvider());
    expect(() => registry.taskProviders.register(new FakeTaskProvider())).toThrow(
      /already registered/,
    );
  });

  it('a stale unregister does not remove a newer item with the same id', () => {
    const registry = new Registry();
    const off = registry.connectors.register(new FakeAppConnector('dart'));
    off();
    const second = new FakeAppConnector('dart');
    registry.connectors.register(second);
    off();
    expect(registry.connectors.get('dart')).toBe(second);
  });
});

describe('EventBus', () => {
  it('delivers typed payloads and unsubscribes', () => {
    const bus = new EventBus();
    const cb = vi.fn();
    const off = bus.on('claude.done', cb);
    bus.emit('claude.done', { sessionId: 's1' });
    off();
    bus.emit('claude.done', {});
    expect(cb).toHaveBeenCalledExactlyOnceWith({ sessionId: 's1' });
  });

  it('keeps delivering when one listener throws', () => {
    const onError = vi.fn();
    const bus = new EventBus(onError);
    const second = vi.fn();
    bus.on('app.detached', () => {
      throw new Error('bad listener');
    });
    bus.on('app.detached', second);
    bus.emit('app.detached', { appId: 'a' });
    expect(second).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'app.detached');
  });

  it('onAny receives every event with its name', () => {
    const bus = new EventBus();
    const cb = vi.fn();
    const off = bus.onAny(cb);
    bus.emit('app.detached', { appId: 'a' });
    bus.emit('claude.done', {});
    off();
    bus.emit('claude.done', {});
    expect(cb.mock.calls).toEqual([
      ['app.detached', { appId: 'a' }],
      ['claude.done', {}],
    ]);
  });
});
