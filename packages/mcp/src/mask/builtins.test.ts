import { describe, expect, it } from 'vitest';
import { maskBuiltIn } from './builtins.js';

describe('built-in masking', () => {
  it.each([
    ['email', 'login ok for jane.doe+test@example.co.uk now', 'login ok for [email masked] now'],
    [
      'bearer token',
      'Authorization: Bearer abc123DEF456ghi789',
      'Authorization: Bearer [token masked]',
    ],
    ['lower-case bearer', 'header bearer s3cr3t-T0ken.value', 'header bearer [token masked]'],
    [
      'JWT',
      'token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'token=[token masked]',
    ],
    ['long hex', 'key 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b', 'key [secret masked]'],
    [
      'long base64',
      ['api key AI', 'zaSyD3x9Kq7Lm2Np4Rs6Tu8Vw0Xy1Za3Bc5De7 used'].join(''),
      'api key [secret masked] used',
    ],
    ['international phone', 'call +44 7700 900123 later', 'call [phone masked] later'],
    ['UK mobile', 'sms to 07700900123', 'sms to [phone masked]'],
    ['US phone', 'phone (555) 123-4567 saved', 'phone [phone masked] saved'],
  ])('masks a %s', (_name, input, expected) => {
    expect(maskBuiltIn(input)).toBe(expected);
  });

  it.each([
    ['date', 'started 2026-10-14 12:30:45'],
    ['epoch millis', 'ts=1760000000000'],
    ['IP address', 'connect to 192.168.100.200'],
    ['version', 'Flutter 3.35.4 • channel stable'],
    ['Dart path', 'package:shop_app/src/features/checkout/CheckoutScreen.dart:42:7'],
    ['short hex', 'isolate 0x7f3a9c'],
    ['run of one hex letter', `x ${'a'.repeat(64)}`],
    ['plain words', 'Reloaded 3 of 1210 libraries in 412ms'],
  ])('leaves a %s alone', (_name, input) => {
    expect(maskBuiltIn(input)).toBe(input);
  });

  it.each([
    [
      'VM service URI',
      'The Dart VM service is listening on http://127.0.0.1:40229/Vt6jT5lXFNM=/',
      'The Dart VM service is listening on http://127.0.0.1:40229/[auth code masked]',
    ],
    [
      'VM service WebSocket URI',
      'ws://127.0.0.1:40229/Vt6jT5lXFNM=/ws connected',
      'ws://127.0.0.1:40229/[auth code masked] connected',
    ],
    [
      'DTD URI',
      'DTD at ws://127.0.0.1:53211/X7mQ2pLk9aB=',
      'DTD at ws://127.0.0.1:53211/[auth code masked]',
    ],
    [
      'DTD URI without padding',
      'dtd ws://localhost:53211/q8ZtYb2Wd4Kx',
      'dtd ws://localhost:53211/[auth code masked]',
    ],
    [
      'auth code in a remote URL',
      'GET https://api.example.com/v1/AbCdEf12Gh==/items',
      'GET https://api.example.com/[auth code masked]',
    ],
    [
      'user and password in a URL',
      'connect wss://admin:hunter2@db.example.com:5432/app',
      'connect wss://[auth code masked]@db.example.com:5432/app',
    ],
  ])('masks the secret part of a %s', (_name, input, expected) => {
    expect(maskBuiltIn(input)).toBe(expected);
  });

  it.each([
    ['dashboard URL', 'dashboard at http://127.0.0.1:9147/'],
    ['plain API URL', 'GET https://api.example.com/v1/users/42?page=2'],
    ['local route', 'http://localhost:8080/products/details'],
  ])('leaves a %s alone', (_name, input) => {
    expect(maskBuiltIn(input)).toBe(input);
  });

  it('stays fast on a hostile 4 kB line', () => {
    const lines = [
      'a'.repeat(4096),
      'a.'.repeat(2048),
      '1 '.repeat(2048),
      `${'a'.repeat(4000)}@`,
      'eyJ'.repeat(1365),
      '+1'.repeat(2048),
      `http://${'a'.repeat(4089)}`,
      'http://a/'.repeat(455),
      `ws://h/${'A1='.repeat(1363)}`,
      'ws://a:'.repeat(585),
    ];
    const start = performance.now();
    for (const line of lines) maskBuiltIn(line);
    expect(performance.now() - start).toBeLessThan(200);
  });
});
