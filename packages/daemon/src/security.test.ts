import { describe, expect, it } from 'vitest';
import {
  generateToken,
  isAllowedHost,
  isAllowedOrigin,
  tokenFromHeaders,
  tokensEqual,
} from './security.js';

describe('isAllowedHost', () => {
  it('accepts only loopback names on our port', () => {
    expect(isAllowedHost('127.0.0.1:9100', 9100)).toBe(true);
    expect(isAllowedHost('localhost:9100', 9100)).toBe(true);
    expect(isAllowedHost('localhost:9101', 9100)).toBe(false);
    expect(isAllowedHost('evil.example:9100', 9100)).toBe(false);
    expect(isAllowedHost('127.0.0.1.evil.example:9100', 9100)).toBe(false);
    expect(isAllowedHost(undefined, 9100)).toBe(false);
  });
});

describe('isAllowedOrigin', () => {
  it('allows no origin and same-origin pages only', () => {
    expect(isAllowedOrigin(undefined, 9100)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:9100', 9100)).toBe(true);
    expect(isAllowedOrigin('http://localhost:9100', 9100)).toBe(true);
    expect(isAllowedOrigin('https://evil.example', 9100)).toBe(false);
    expect(isAllowedOrigin('http://localhost:3000', 9100)).toBe(false);
    expect(isAllowedOrigin('null', 9100)).toBe(false);
  });
});

describe('tokens', () => {
  it('generates long, distinct tokens', () => {
    const a = generateToken();
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(generateToken()).not.toBe(a);
  });

  it('reads the custom header or a bearer token', () => {
    const headers = (h: Record<string, string>) => (n: string) => h[n];
    expect(tokenFromHeaders(headers({ 'x-deck-token': 'abc' }))).toBe('abc');
    expect(tokenFromHeaders(headers({ authorization: 'Bearer abc' }))).toBe('abc');
    expect(tokenFromHeaders(headers({ authorization: 'Basic abc' }))).toBeUndefined();
  });

  it('compares tokens', () => {
    expect(tokensEqual('abc', 'abc')).toBe(true);
    expect(tokensEqual('abd', 'abc')).toBe(false);
    expect(tokensEqual('', 'abc')).toBe(false);
    expect(tokensEqual(undefined, 'abc')).toBe(false);
  });
});
