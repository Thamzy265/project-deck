/** Tester probes of the extension allowlist (ADR 0004, design review D7). */
import { describe, expect, it } from 'vitest';
import {
  AppExtensionError,
  DEFAULT_EXTENSION_PREFIXES,
  MAX_EXTENSION_PARAMS,
  MAX_EXTENSION_PARAMS_LENGTH,
  checkEventKind,
  checkExtensionCall,
  eventKindAllowed,
  isAllowedExtensionMethod,
  isValidExtensionPrefix,
} from './extensions.js';
import { Registry } from './registry.js';

const prefixes = DEFAULT_EXTENSION_PREFIXES;
const METHOD = 'ext.flutterdeck.drift.v1.query';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof AppExtensionError ? err.code : 'other';
  }
  return undefined;
}

describe('method names that try to slip past the allowlist', () => {
  it.each([
    'ext.Flutter.exit',
    'ext.FLUTTER.exit',
    'ext.flutter.exit',
    'Ext.flutterdeck.x',
    'EXT.flutterdeck.x',
    'ext.flutterdeck',
    'ext.flutterdeckx.y',
    'ext.flutterdeck_x.y',
    'ext.flutterdeck.x.',
    'ext.flutterdeck.x\n',
    '\next.flutterdeck.x',
    ' ext.flutterdeck.x',
    'ext.flutterdeck.x ',
    'ext.flutterdeck.x\u0000',
    'ext.flutterdeck.x/../flutter.exit',
    'ext.flutterdeck.x;ext.flutter.exit',
    'ext.flutterdeck․x',
    'ext.flutterdeсk.x', // Cyrillic es
    'ext.flutterdeck.ｘ', // full-width x
    'ext．flutterdeck.x',
    `ext.flutterdeck.${'a'.repeat(200)}`,
    'ext.dds.x',
    'ext.dart.io.getOpenFiles',
    'ext.drift.database',
    '',
  ])('refuses %j', (method) => {
    expect(isAllowedExtensionMethod(method, prefixes)).toBe(false);
    expect(codeOf(() => checkExtensionCall(method, {}, prefixes))).toBe('not-allowed');
  });

  it('never lets a broad or blocked prefix reach Flutter, Drift, Dart or DDS', () => {
    const broad = [
      'ext.',
      'ext.flutter.',
      'ext.drift.',
      'ext.dart.',
      'ext.dds.',
      'ext.flutterdeck',
    ];
    for (const method of ['ext.flutter.exit', 'ext.drift.database', 'ext.dart.io.x', 'ext.dds.x']) {
      expect(isAllowedExtensionMethod(method, broad), method).toBe(false);
    }
    for (const prefix of [
      'ext.',
      'ext.flutter.',
      'ext.flutter.x.',
      'ext.drift.',
      'ext.dart.io.',
      'ext.dds.',
      'EXT.flutterdeck.',
      'ext.flutterdeck',
      'ext..',
    ]) {
      expect(isValidExtensionPrefix(prefix), prefix).toBe(false);
    }
  });

  it('keeps the method under the same prefix it matched, not a longer look-alike', () => {
    expect(isAllowedExtensionMethod('ext.flutterdeckevil.x', ['ext.flutterdeck.'])).toBe(false);
    expect(isAllowedExtensionMethod('ext.flutterdeck.drift.x', ['ext.flutterdeck.drift.'])).toBe(
      true,
    );
    expect(isAllowedExtensionMethod('ext.flutterdeck.driftx.y', ['ext.flutterdeck.drift.'])).toBe(
      false,
    );
  });

  // EXT-1: dart:ui registers ext.ui.window.* in every Flutter app; D7 says Flutter's own
  // extensions can never be reached, but ext.ui. is a valid prefix today.
  it('EXT-1 blocks the Flutter engine prefix ext.ui.', () => {
    expect(isValidExtensionPrefix('ext.ui.')).toBe(false);
    expect(isAllowedExtensionMethod('ext.ui.window.scheduleFrame', ['ext.ui.'])).toBe(false);
    for (const prefix of ['ext.flutter.', 'ext.drift.', 'ext.dart.', 'ext.dds.', 'ext.ui.']) {
      expect(isValidExtensionPrefix(prefix), prefix).toBe(false);
      expect(isValidExtensionPrefix(`${prefix}x.`), prefix).toBe(false);
    }
  });
});

describe('extension parameters', () => {
  it.each([
    'isolateId',
    'IsolateId x',
    '__proto__',
    'constructor ',
    '_hidden',
    '1st',
    'a-b',
    'a.b',
    '',
    'x'.repeat(65),
  ])('refuses the parameter name %j', (key) => {
    expect(codeOf(() => checkExtensionCall(METHOD, { [key]: 'v' }, prefixes))).toBe('invalid-call');
  });

  it('refuses an own __proto__ key from parsed JSON', () => {
    const params = JSON.parse('{"__proto__": "x"}') as Record<string, string>;
    expect(codeOf(() => checkExtensionCall(METHOD, params, prefixes))).toBe('invalid-call');
  });

  it('allows names that only look like isolateId, since the connector sets its own', () => {
    expect(
      codeOf(() => checkExtensionCall(METHOD, { isolateid: 'x', isolateId2: 'y' }, prefixes)),
    ).toBeUndefined();
  });

  it.each([
    ['a number', 1],
    ['null', null],
    ['an object', { a: 1 }],
    ['an array', ['x']],
    ['undefined', undefined],
  ])('refuses %s as a value', (_name, value) => {
    const params = { sql: value } as unknown as Record<string, string>;
    expect(codeOf(() => checkExtensionCall(METHOD, params, prefixes))).toBe('invalid-call');
  });

  it('takes exactly the parameter count and size limits and refuses one more', () => {
    const many = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, 'v']));
    expect(
      codeOf(() => checkExtensionCall(METHOD, many(MAX_EXTENSION_PARAMS), prefixes)),
    ).toBeUndefined();
    expect(codeOf(() => checkExtensionCall(METHOD, many(MAX_EXTENSION_PARAMS + 1), prefixes))).toBe(
      'invalid-call',
    );
    const half = MAX_EXTENSION_PARAMS_LENGTH / 2;
    const sized = (extra: number) => ({ a: 'x'.repeat(half), b: 'x'.repeat(half + extra) });
    expect(codeOf(() => checkExtensionCall(METHOD, sized(0), prefixes))).toBeUndefined();
    expect(codeOf(() => checkExtensionCall(METHOD, sized(1), prefixes))).toBe('invalid-call');
  });

  it('checks the name before the parameters, so a blocked method never leaks param errors', () => {
    expect(codeOf(() => checkExtensionCall('ext.flutter.exit', { isolateId: 'x' }, prefixes))).toBe(
      'not-allowed',
    );
  });

  it('cuts a huge method name in its error message', () => {
    const method = `ext.flutter.${'x'.repeat(10_000)}`;
    try {
      checkExtensionCall(method, {}, prefixes);
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(AppExtensionError);
      expect(err instanceof Error ? err.message.length : 0).toBeLessThan(200);
    }
  });
});

describe('event kinds', () => {
  it.each([
    'flutterdeck',
    'flutterdeck.',
    'Flutterdeck.drift.tables',
    'flutterdeckx.drift',
    'ext.flutterdeck.drift.tables',
    'Flutter.Frame',
    'flutterdeck..x',
    'flutterdeck.x\n',
    `flutterdeck.${'x'.repeat(200)}`,
  ])('refuses listeners for %j', (kind) => {
    expect(eventKindAllowed(kind, prefixes)).toBe(false);
    expect(codeOf(() => checkEventKind(kind, prefixes))).toBe('not-allowed');
  });

  it('ignores invalid prefixes when matching kinds', () => {
    expect(eventKindAllowed('Flutter.Frame', ['ext.Flutter.'])).toBe(false);
    expect(eventKindAllowed('flutter.frame', ['ext.flutter.'])).toBe(false);
  });
});

describe('Registry extension prefixes', () => {
  it('keeps the default prefix when a backend adds and removes it again', () => {
    const registry = new Registry();
    const remove = registry.allowExtensionPrefix('ext.flutterdeck.');
    remove();
    remove();
    expect(registry.extensionPrefixes()).toEqual(['ext.flutterdeck.']);
  });

  // EXT-2: the first backend to remove a shared prefix removes it for every backend.
  it.fails('EXT-2 keeps a prefix two backends added until both remove it', () => {
    const registry = new Registry();
    const removeA = registry.allowExtensionPrefix('ext.flutterdeck.drift.');
    registry.allowExtensionPrefix('ext.flutterdeck.drift.');
    removeA();
    expect(registry.extensionPrefixes()).toContain('ext.flutterdeck.drift.');
  });
});
