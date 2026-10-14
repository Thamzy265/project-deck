/**
 * Tester probes of the Masker: the 4 kB cut, Unicode at the cut, and values that sit
 * across the cut. Known leaks are `it.fails` repros with a bug id from the tester report.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { JsonValue } from './masker.js';
import { CUT_MARKER, MAX_TEXT, Masker } from './masker.js';

const maskers: Masker[] = [];
function masker(rules: string[] = [], redact = true): Masker {
  const m = new Masker({ redact, rules });
  maskers.push(m);
  return m;
}

afterEach(async () => {
  await Promise.all(maskers.splice(0).map((m) => m.close()));
});

async function maskText(text: string, m: Masker = masker()): Promise<string> {
  const out = await m.mask(text);
  return out.value;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** `before` ends exactly `at` characters into the text, then `value` follows. */
function straddle(value: string, at: number): string {
  return 'x '.repeat(MAX_TEXT).slice(0, MAX_TEXT - at) + value + ' tail';
}

describe('the 4 kB cut', () => {
  it('keeps a whole surrogate pair or drops it, never half', async () => {
    // The emoji's high surrogate is the 4096th UTF-16 unit.
    const text = 'a'.repeat(MAX_TEXT - 1) + '😀' + 'b';
    const out = await maskText(text);
    expect(out).toBe('a'.repeat(MAX_TEXT - 1) + CUT_MARKER);
    expect(out).not.toMatch(LONE_SURROGATE);
  });

  it('keeps a surrogate pair that ends exactly at the cut', async () => {
    const text = 'a'.repeat(MAX_TEXT - 2) + '😀' + 'b';
    const out = await maskText(text);
    expect(out).toBe('a'.repeat(MAX_TEXT - 2) + '😀' + CUT_MARKER);
    expect(out).not.toMatch(LONE_SURROGATE);
  });

  it('cuts with masking off too, and says masking is off', async () => {
    const m = masker([], false);
    const out = await m.mask({ message: 'jane@example.com ' + 'z'.repeat(MAX_TEXT) });
    expect(out.value.message).toBe(
      ('jane@example.com ' + 'z'.repeat(MAX_TEXT)).slice(0, MAX_TEXT) + CUT_MARKER,
    );
    expect(out.notes).toEqual(['Masking for Claude is off']);
  });

  it('never cuts a marker: markers are added after the cut', async () => {
    const text = 'z'.repeat(MAX_TEXT - 20) + ' jane@example.com';
    const out = await maskText(text);
    expect(out.endsWith('[email masked]')).toBe(true);
  });

  it('masks a value that ends exactly at the cut', async () => {
    const email = 'jane.doe@example.com';
    const out = await maskText(straddle(email, email.length));
    expect(out).not.toContain('jane.doe');
    expect(out).toContain('[email masked]');
  });

  it.fails('BUG-MCP-T3: hides the part of an email left before the cut', async () => {
    // 'jane.doe@exam' survives the cut, and without a dot after @ it isn't an email any more.
    const out = await maskText(straddle('jane.doe@example.com', 'jane.doe@exam'.length));
    expect(out).not.toContain('jane.doe');
  });

  it('BUG-MCP-T3: hides the payload of a JWT whose signature is cut off', async () => {
    // {"sub":"1234567890"}: a user id, short enough to miss the long-secret rule.
    const payload = 'eyJzdWIiOiIxMjM0NTY3ODkwIn0';
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${payload}.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c`;
    // Cut three characters into the signature: two parts and a stub remain.
    const out = await maskText(straddle(jwt, jwt.indexOf('.Sfl') + 4));
    expect(out).not.toContain(payload);
  });

  it.fails('BUG-MCP-T3: hides a Bearer token cut below 8 characters', async () => {
    const out = await maskText(straddle('Bearer s3cr3tT0kenValue', 'Bearer s3cr3tT'.length));
    expect(out).not.toContain('s3cr3tT');
  });
});

describe('nested values', () => {
  it('masks strings at any depth and leaves numbers, booleans and null alone', async () => {
    const value: JsonValue = {
      a: [{ b: [[{ c: 'call +44 7700 900123' }]] }],
      n: 4477009001234,
      t: true,
      z: null,
    };
    const out = await masker().mask(value);
    expect(out.value).toEqual({
      a: [{ b: [[{ c: 'call [phone masked]' }]] }],
      n: 4477009001234,
      t: true,
      z: null,
    });
  });

  it('cuts each string on its own, so many strings may each be 4 kB', async () => {
    const big = 'q'.repeat(MAX_TEXT + 10);
    const out = await masker().mask([big, big]);
    expect(out.value).toEqual([
      big.slice(0, MAX_TEXT) + CUT_MARKER,
      big.slice(0, MAX_TEXT) + CUT_MARKER,
    ]);
  });
});
