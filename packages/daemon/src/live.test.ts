import { Registry } from '@project-deck/core';
import { describe, expect, it } from 'vitest';
import { registerLive } from './live.js';

describe('registerLive', () => {
  it('registers the Dart connector and the Android logcat feed', () => {
    const registry = new Registry();
    registerLive(registry, { dtdUris: [], vmServiceUris: [] }, () => undefined);
    expect(registry.connectors.list().map((c) => c.id)).toEqual(['dart']);
    expect(registry.logFeeds.list().map((f) => f.id)).toEqual(['android-logcat']);
  });
});
