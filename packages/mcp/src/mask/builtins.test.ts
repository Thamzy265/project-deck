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

  it('stays fast on a hostile 4 kB line', () => {
    const lines = [
      'a'.repeat(4096),
      'a.'.repeat(2048),
      '1 '.repeat(2048),
      `${'a'.repeat(4000)}@`,
      'eyJ'.repeat(1365),
      '+1'.repeat(2048),
    ];
    const start = performance.now();
    for (const line of lines) maskBuiltIn(line);
    expect(performance.now() - start).toBeLessThan(200);
  });
});
