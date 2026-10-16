import { describe, expect, it, vi } from 'vitest';
import {
  AppExtensionError,
  DEFAULT_EXTENSION_PREFIXES,
  DEFAULT_EXTENSION_TIMEOUT_MS,
  MAX_EXTENSION_TIMEOUT_MS,
  checkExtensionCall,
  eventKindAllowed,
  extensionTimeout,
  isAllowedExtensionMethod,
  isValidExtensionPrefix,
} from './extensions.js';
import { Registry } from './registry.js';
import { FakeAppExtensions, FakeAppSession, fakeApp } from './testing/index.js';

const prefixes = DEFAULT_EXTENSION_PREFIXES;

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof AppExtensionError ? err.code : 'other';
  }
  return undefined;
}

describe('extension method names', () => {
  it('allow only methods under an allowed prefix, starting with ext.flutterdeck.', () => {
    expect(prefixes).toEqual(['ext.flutterdeck.']);
    expect(isAllowedExtensionMethod('ext.flutterdeck.drift.v1.query', prefixes)).toBe(true);
    for (const method of [
      'ext.flutter.debugDumpApp',
      'ext.drift.database',
      'ext.dart.io.getSocketProfile',
      'ext.flutterdeck',
      'ext.flutterdeck.',
      'ext.flutterdeck..x',
      'ext.flutterdeck.Drift',
      'ext.flutterdeck.drift query',
      'getVM',
      'streamListen',
      's0.reloadSources',
      `ext.flutterdeck.${'a'.repeat(200)}`,
    ]) {
      expect(isAllowedExtensionMethod(method, prefixes), method).toBe(false);
    }
  });

  it('never allow the Flutter, Drift or Dart extensions, whatever the prefixes say', () => {
    expect(isAllowedExtensionMethod('ext.flutter.debugDumpApp', ['ext.'])).toBe(false);
    expect(isAllowedExtensionMethod('ext.drift.database', ['ext.drift.'])).toBe(false);
    expect(isValidExtensionPrefix('ext.drift.')).toBe(false);
    expect(isValidExtensionPrefix('ext.flutter.')).toBe(false);
    expect(isValidExtensionPrefix('ext.')).toBe(false);
    expect(isValidExtensionPrefix('ext.flutterdeck')).toBe(false);
    expect(isValidExtensionPrefix('ext.flutterdeck.drift.')).toBe(true);
  });

  it('deliver events only of kinds under the allowed prefixes, without ext.', () => {
    expect(eventKindAllowed('flutterdeck.drift.tables', prefixes)).toBe(true);
    expect(eventKindAllowed('Flutter.Frame', prefixes)).toBe(false);
    expect(eventKindAllowed('flutterdeck', prefixes)).toBe(false);
  });
});

describe('checkExtensionCall', () => {
  it('accepts string parameters and refuses the reserved isolateId', () => {
    expect(codeOf(() => checkExtensionCall('ext.flutterdeck.a.b', { sql: 'x' }, prefixes))).toBe(
      undefined,
    );
    expect(
      codeOf(() => checkExtensionCall('ext.flutterdeck.a.b', { isolateId: 'x' }, prefixes)),
    ).toBe('invalid-call');
    expect(codeOf(() => checkExtensionCall('ext.flutter.exit', {}, prefixes))).toBe('not-allowed');
  });

  it('refuses bad keys, non-string values, too many and too large parameters', () => {
    const call = (params: Record<string, unknown>) =>
      codeOf(() =>
        checkExtensionCall('ext.flutterdeck.a.b', params as Record<string, string>, prefixes),
      );
    expect(call({ 'bad key': 'x' })).toBe('invalid-call');
    expect(call({ n: 1 })).toBe('invalid-call');
    expect(call(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 'v'])))).toBe(
      'invalid-call',
    );
    expect(call({ sql: 'x'.repeat(300_000) })).toBe('invalid-call');
  });

  it('defaults the timeout and caps it', () => {
    expect(extensionTimeout(undefined)).toBe(DEFAULT_EXTENSION_TIMEOUT_MS);
    expect(DEFAULT_EXTENSION_TIMEOUT_MS).toBe(5000);
    expect(extensionTimeout(10)).toBe(10);
    expect(extensionTimeout(10 ** 9)).toBe(MAX_EXTENSION_TIMEOUT_MS);
    expect(extensionTimeout(0)).toBe(DEFAULT_EXTENSION_TIMEOUT_MS);
    expect(extensionTimeout(Number.NaN)).toBe(DEFAULT_EXTENSION_TIMEOUT_MS);
  });
});

describe('Registry extension prefixes', () => {
  it('starts with ext.flutterdeck. and adds valid prefixes only', () => {
    const registry = new Registry();
    expect(registry.extensionPrefixes()).toEqual(['ext.flutterdeck.']);
    const remove = registry.allowExtensionPrefix('ext.flutterdeck.drift.');
    expect(registry.extensionPrefixes()).toContain('ext.flutterdeck.drift.');
    remove();
    expect(registry.extensionPrefixes()).toEqual(['ext.flutterdeck.']);
    expect(() => registry.allowExtensionPrefix('ext.drift.')).toThrow();
  });
});

describe('FakeAppExtensions', () => {
  it('calls programmed handlers and records the calls', async () => {
    const ext = new FakeAppExtensions().handle('ext.flutterdeck.drift.v1.list', (params) => ({
      echo: params,
    }));
    expect(ext.has('ext.flutterdeck.drift.v1.list')).toBe(true);
    expect(ext.has('ext.flutterdeck.drift.v1.query')).toBe(false);
    await expect(ext.call('ext.flutterdeck.drift.v1.list', { a: '1' })).resolves.toEqual({
      echo: { a: '1' },
    });
    expect(ext.calls).toEqual([{ method: 'ext.flutterdeck.drift.v1.list', params: { a: '1' } }]);
  });

  it('rejects a missing extension, a disallowed method and a handler failure with codes', async () => {
    const ext = new FakeAppExtensions().handle('ext.flutterdeck.x.fail', () => {
      throw new Error('boom');
    });
    await expect(ext.call('ext.flutterdeck.x.none', {})).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(ext.call('ext.flutter.exit', {})).rejects.toMatchObject({ code: 'not-allowed' });
    await expect(ext.call('ext.flutterdeck.x.fail', {})).rejects.toMatchObject({
      code: 'failed',
      message: 'boom',
    });
  });

  it('times out a handler that never answers', async () => {
    const ext = new FakeAppExtensions().handle(
      'ext.flutterdeck.x.hang',
      () => new Promise(() => {}),
    );
    await expect(ext.call('ext.flutterdeck.x.hang', {}, { timeoutMs: 20 })).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('emits events to listeners of allowed kinds and stops after unsubscribe', () => {
    const ext = new FakeAppExtensions();
    const cb = vi.fn();
    const off = ext.onEvent('flutterdeck.drift.tables', cb);
    ext.emit('flutterdeck.drift.tables', { db: 'app' });
    ext.emit('flutterdeck.other', { db: 'app' });
    off();
    ext.emit('flutterdeck.drift.tables', { db: 'app' });
    expect(cb).toHaveBeenCalledExactlyOnceWith({ db: 'app' });
    expect(() => ext.onEvent('Flutter.Frame', cb)).toThrow(AppExtensionError);
  });

  it('is offered by a fake session only when given, and stops answering after detach', async () => {
    expect(new FakeAppSession(fakeApp()).extensions).toBeUndefined();
    const ext = new FakeAppExtensions().handle('ext.flutterdeck.x.ok', () => 'ok');
    const session = new FakeAppSession(fakeApp(), { extensions: ext });
    expect(session.extensions).toBe(ext);
    await session.detach();
    await expect(ext.call('ext.flutterdeck.x.ok', {})).rejects.toMatchObject({ code: 'detached' });
  });
});
