/**
 * Tester probes of the built-in masking (design D4): common secret formats it should
 * catch, and normal Flutter log text it should leave alone. Masking is best effort, so
 * only formats that are common in Flutter and HTTP client logs are held to it. Known
 * misses are `it.fails` repros with a bug id from the tester report.
 */
import { describe, expect, it } from 'vitest';
import { maskBuiltIn } from './builtins.js';

const EMAIL = '[email masked]';
const TOKEN = '[token masked]';

/** Asserts the secret part is gone from the masked text, whatever marker replaced it. */
function hides(text: string, secret: string): void {
  const out = maskBuiltIn(text);
  expect(out).not.toContain(secret);
  expect(out).toMatch(/\[(email|phone|token|secret) masked\]/);
}

describe('built-in masking catches', () => {
  it.each([
    ['Authorization: Bearer abc.def-ghi_jkl', 'abc.def-ghi_jkl'],
    ['authorization:BEARER\tabcdefghijkl', 'abcdefghijkl'],
    ['bearer      ZXhhbXBsZS10b2tlbg', 'ZXhhbXBsZS10b2tlbg'],
    ['Bearer\nabcdefghijkl', 'abcdefghijkl'],
  ])('a Bearer token with odd spacing or case: %j', (text, secret) => {
    hides(text, secret);
    // The word stays as written, so the line still reads as an auth header.
    expect(maskBuiltIn(text)).toContain(TOKEN);
  });

  it('a signed JWT (the jwt.io sample)', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(maskBuiltIn(`id_token=${jwt}`)).toBe(`id_token=${TOKEN}`);
  });

  it.each([
    ['Google API key', ['AI', 'zaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY'].join('')],
    ['GitHub classic token', ['gh', 'p_16C7e42F292c6912E7710c838347Ae178B4a'].join('')],
    [
      'GitHub fine-grained token',
      [
        'gi',
        'thub_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV012345',
      ].join(''),
    ],
    ['Stripe live key', ['sk', '_live_4eC39HqLyjWDarjtT1zdp7dc'].join('')],
    ['Slack bot token', ['xo', 'xb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx'].join('')],
    ['FCM-style base64 token', 'dGVzdC10b2tlbjphc2Rmc2RmMTIzNDU2Nzg5MDEyMzQ1Njc4OTA'],
  ])('a %s', (_name, secret) => {
    hides(`key: ${secret} end`, secret);
  });

  it.each([
    ['tag', 'jane@example.com'],
    ['app name', 'Jane.Doe+shop@mail.example.co.uk'],
    ['device name', "jane@example.com's Pixel 8"],
    ['error message', 'SocketException: user=jane@example.com failed'],
    ['mailto link', 'mailto:jane@example.com'],
  ])('an email inside a %s', (_where, text) => {
    expect(maskBuiltIn(text)).toContain(EMAIL);
    expect(maskBuiltIn(text)).not.toMatch(/jane|Jane/);
  });

  it.each([['+44 7700 900123'], ['07700900123'], ['(020) 7946 0958'], ['+1-202-555-0143']])(
    'a phone number %j',
    (phone) => {
      expect(maskBuiltIn(`call ${phone} now`)).toBe('call [phone masked] now');
    },
  );

  it('masks each JSON field on its own, so a field never unmasks its neighbour', () => {
    const text = '{"email":"jane@example.com","auth":"Bearer abcdefghijklmnop"}';
    expect(maskBuiltIn(text)).toBe(`{"email":"${EMAIL}","auth":"Bearer ${TOKEN}"}`);
  });
});

describe('built-in masking misses (repros)', () => {
  it('BUG-MCP-T4: masks an AWS access key id (the documented example)', () => {
    // AWS's documented example key id.
    hides(
      ['aws_access_key_id = AK', 'IAIOSFODNN7EXAMPLE'].join(''),
      ['AK', 'IAIOSFODNN7EXAMPLE'].join(''),
    );
  });

  it.fails('BUG-MCP-T5: masks a URL-encoded email in a logged request URL', () => {
    // Dio and http loggers print query strings as sent: @ becomes %40.
    hides('GET https://api.example.com/users?email=jane.doe%40example.com', 'jane.doe');
  });

  it('BUG-MCP-T6: masks a JWT whose parts keep their base64 padding', () => {
    // Short payloads (here {"sub":"1234567890"}) are under the 32-character secret rule.
    const payload = 'eyJzdWIiOiIxMjM0NTY3ODkwIn0=';
    hides(`token eyJhbGciOiJIUzI1NiJ9.${payload}.SflKxwRJSMeKKF2QT4fwpMeJf36POk6y=`, payload);
  });

  it('BUG-MCP-T6: masks an unsigned JWT (alg none, empty signature)', () => {
    const payload = 'eyJzdWIiOiIxMjM0NTY3ODkwIn0';
    hides(`token eyJhbGciOiJub25lIn0.${payload}.`, payload);
  });

  it('BUG-MCP-T7: masks an HTTP Basic auth header', () => {
    // base64("user:password"): the password is one decode away.
    hides('Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA');
  });

  it('BUG-MCP-T7: masks a short secret named by its key', () => {
    hides('{"access_token":"Zk3xQ9mP2vL8wR4t","password":"hunter2"}', 'Zk3xQ9mP2vL8wR4t');
  });
});

describe('built-in masking leaves normal Flutter log text alone', () => {
  it.each([
    '2026-10-14 12:34:56.789 I/flutter (12345): started',
    'Build took 1234567 ms',
    'ts=1697040000000 frame=12',
    'Duration 0:00:01.234567',
    'color: Color(0xFF2196F3)',
    '#0      main (package:shop_app/main.dart:10:5)',
    '#1      _CustomZone.run (dart:async/zone.dart:1654:54)',
    'package:flutter/src/widgets/framework.dart',
    'uuid 123e4567-e89b-12d3-a456-426614174000',
    'version 3.24.0+1 on 192.168.0.10:8080',
    'android.view.ViewRootImpl$ViewRootHandler@a1b2c3d',
    'Instance of _HomePageState#a1b2c',
    'size 1080x2340 density 2.75, memory 123456789 bytes',
    'dashboard at http://127.0.0.1:9147/',
  ])('%j', (text) => {
    expect(maskBuiltIn(text)).toBe(text);
  });

  it('masks long hex hashes (git, sha256) by design: they look like secrets', () => {
    // Accepted over-masking (D4 "long hex secrets"): a commit hash is rarely what Claude needs.
    expect(maskBuiltIn('commit 3f786850e387550fdab836ed7e6dc881de23001b')).toBe(
      'commit [secret masked]',
    );
  });

  it.fails('BUG-MCP-T8: leaves a resolution-variant asset path (logo@2x.png) alone', () => {
    // Flutter asset variants are named name@2x.png; "Unable to load asset" errors print them.
    const text = 'Unable to load asset: assets/images/logo@2x.png';
    expect(maskBuiltIn(text)).toBe(text);
  });
});
