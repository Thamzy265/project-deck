/**
 * The Dart package and this backend share names by hand: the extension prefix, the event
 * kind, the protocol version and the action list. After the FlutterDeck -> Pitdeck rename
 * (M5 batch 1) only one side could change without a Dart or TS test noticing, so this
 * reads the Dart source and compares. The recorded fixture covers the wire shapes.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_EXTENSION_PREFIXES } from '@project-deck/core';
import { describe, expect, it } from 'vitest';
import { EXTENSION_PREFIX, PROTOCOL_VERSION, TABLES_EVENT } from './protocol.js';

const DART = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'dart',
  'pitdeck_drift',
);
const read = (rel: string): string => readFileSync(join(DART, rel), 'utf8');
const protocolDart = read('lib/src/protocol.dart');
const registerDart = read('lib/src/register.dart');

function dartConst(source: string, name: string): string | undefined {
  return new RegExp(`const ${name} = ([^;]+);`).exec(source)?.[1];
}

describe('pitdeck_drift (Dart) and db-drift (TS) agree', () => {
  it('on the extension prefix', () => {
    expect(dartConst(protocolDart, 'extensionPrefix')).toBe(`'${EXTENSION_PREFIX}'`);
  });

  it('on the event kind, which the connector derives from the prefix without `ext.`', () => {
    expect(dartConst(protocolDart, 'tablesEventKind')).toBe(`'${TABLES_EVENT}'`);
    expect(
      TABLES_EVENT.startsWith(DEFAULT_EXTENSION_PREFIXES[0]?.slice('ext.'.length) ?? '?'),
    ).toBe(true);
  });

  it('on the protocol version', () => {
    expect(dartConst(protocolDart, 'protocolVersion')).toBe(String(PROTOCOL_VERSION));
  });

  it('on the connector prefix that lets the extensions through', () => {
    expect(DEFAULT_EXTENSION_PREFIXES.some((p) => EXTENSION_PREFIX.startsWith(p))).toBe(true);
  });

  it('on the list of actions', () => {
    const list = /const extensionNames = \[([^\]]*)\]/.exec(registerDart)?.[1] ?? '';
    const names = [...list.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
    expect(names).toEqual(['execute', 'list', 'query', 'rows', 'schema', 'snapshot']);
  });

  it('on a package name that no longer says flutterdeck', () => {
    expect(read('pubspec.yaml')).toMatch(/^name: pitdeck_drift$/m);
    expect(registerDart + protocolDart).not.toMatch(/flutterdeck/i);
  });
});
