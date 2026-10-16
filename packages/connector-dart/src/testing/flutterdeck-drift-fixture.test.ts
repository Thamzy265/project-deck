/**
 * Hygiene of the recorded flutterdeck_drift session (fixtures/flutterdeck-drift-v1.recorded.json):
 * CLAUDE.md says recorded traffic must not hold tokens, auth codes, VM service URIs, local paths
 * or personal data. Re-recording with tool/record_fixtures.dart must keep it that way.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const text = readFileSync(
  new URL('./fixtures/flutterdeck-drift-v1.recorded.json', import.meta.url),
  'utf8',
);
const fixture = JSON.parse(text) as {
  _source?: unknown;
  exchanges: { label: string; request: { params?: Record<string, unknown> }; response: unknown }[];
};

/** Every string value in the fixture, with the path to it. */
function strings(value: unknown, path = '$'): [string, string][] {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${path}[${i}]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => strings(v, `${path}.${k}`));
  }
  return [];
}

describe('flutterdeck_drift recorded fixture', () => {
  const all = strings(fixture);

  it('names its source', () => {
    expect(typeof fixture._source).toBe('string');
    expect(fixture.exchanges.length).toBeGreaterThan(0);
  });

  it('holds no VM service or DTD URI, and no URL at all', () => {
    for (const [path, s] of all) {
      expect(s, path).not.toMatch(/\b(?:wss?|https?):\/\//i);
    }
  });

  it('holds no local file path', () => {
    for (const [path, s] of all) {
      expect(s, path).not.toMatch(
        /(?:\/Users\/|\/home\/|\/var\/folders\/|\/private\/|\/tmp\/|[A-Za-z]:\\)/,
      );
    }
  });

  it('masks every write token and holds nothing token-shaped', () => {
    const tokens = fixture.exchanges
      .map((e) => e.request.params?.['token'])
      .filter((t) => t !== undefined);
    expect(tokens.length).toBeGreaterThan(0);
    for (const t of tokens) expect(t).toBe('<masked>');
    for (const [path, s] of all) {
      // A write token is 43 base64url characters; auth codes are similar.
      expect(s, path).not.toMatch(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/);
    }
  });

  it('holds no email address or phone-like number', () => {
    // Isolate ids are VM numbers, not personal data.
    for (const [path, s] of all.filter(([p]) => !p.endsWith('.isolateId'))) {
      expect(s, path).not.toMatch(/[^\s@]+@[^\s@]+\.[a-z]{2,}/i);
      expect(s, path).not.toMatch(/\+?\d(?: ?\d){9,}/);
    }
  });
});
