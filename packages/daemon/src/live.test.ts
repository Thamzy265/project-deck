import type * as ConnectorDart from '@project-deck/connector-dart';
import type { DartConnectorOptions } from '@project-deck/connector-dart';
import { Registry } from '@project-deck/core';
import { describe, expect, it, vi } from 'vitest';
import { registerLive } from './live.js';

const seen = vi.hoisted(() => ({ options: [] as unknown[] }));

vi.mock('@project-deck/connector-dart', async (importOriginal) => {
  const real = await importOriginal<typeof ConnectorDart>();
  class RecordingConnector extends real.DartConnector {
    constructor(opts: DartConnectorOptions = {}) {
      super(opts);
      seen.options.push(opts);
    }
  }
  return { ...real, DartConnector: RecordingConnector };
});

describe('registerLive', () => {
  it('registers the Dart connector and the Android logcat feed', () => {
    const registry = new Registry();
    registerLive(registry, { dtdUris: [], vmServiceUris: [] }, () => undefined);
    expect(registry.connectors.list().map((c) => c.id)).toEqual(['dart']);
    expect(registry.logFeeds.list().map((f) => f.id)).toEqual(['android-logcat']);
  });

  it("gives the connector the registry's extension prefixes, including later ones", () => {
    seen.options.length = 0;
    const registry = new Registry();
    registerLive(registry, { dtdUris: [], vmServiceUris: [] }, () => undefined);
    const opts = seen.options[0] as DartConnectorOptions | undefined;
    expect(opts?.extensionPrefixes?.()).toEqual(['ext.flutterdeck.']);
    registry.allowExtensionPrefix('ext.flutterdeck.drift.');
    expect(opts?.extensionPrefixes?.()).toContain('ext.flutterdeck.drift.');
  });
});
