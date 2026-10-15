import { describe, expect, it } from 'vitest';
import { maskBuiltIn } from './builtins.js';

describe('built-in masking', () => {
  it.each([
    ['email', 'login ok for jane.doe+test@example.co.uk now', 'login ok for [email masked] now'],
    [
      'URL-encoded email',
      'GET /users?email=jane.doe%40example.com&x=1',
      'GET /users?email=[email masked]&x=1',
    ],
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
    ['base64 secret with slashes', 'k k3Y/9aB+zXq7W2mP0rT5uV8sL1nH4jF6', 'k [secret masked]'],
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
    ['2x asset', 'Unable to load asset: assets/images/logo@2x.png'],
    ['1.5x asset', 'asset icons/star@1.5x.webp missing'],
    ['path with versioned folders', 'lib/src/features/auth/LoginScreen2V3Widget9.dart'],
    ['package path with digits', 'package:My2App/Src3/Widget4Screen5ViewModel6.dart:10:5'],
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
    [
      'AWS key id',
      ['aws_key AK', 'IAIOSFODNN7EXAMPLE used'].join(''),
      'aws_key [secret masked] used',
    ],
    ['AWS session key id', ['id AS', 'IAY34FZKBOKMUTVV7A'].join(''), 'id [secret masked]'],
    [
      'GitHub token',
      ['gh gh', 's_16C7e42F292c6912E7710c838347Ae178B4a'].join(''),
      'gh [secret masked]',
    ],
    [
      'GitHub OAuth token',
      ['gh gh', 'o_abcdefghijklmnopqrstuvwxyz0123456789'].join(''),
      'gh [secret masked]',
    ],
    [
      'GitHub fine-grained token',
      ['pat gi', 'thub_pat_11ABCDEFG0123456789_abcdefghijklmnop end'].join(''),
      'pat [secret masked] end',
    ],
    [
      'Stripe key',
      ['stripe sk', '_live_4eC39HqLyjWDarjtT1zdp7dc'].join(''),
      'stripe [secret masked]',
    ],
    [
      'Stripe restricted key',
      ['stripe rk', '_live_abcdefghij1234'].join(''),
      'stripe [secret masked]',
    ],
    [
      'Google API key',
      ['maps AI', 'zaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBW-'].join(''),
      'maps [secret masked]',
    ],
    ['Slack token', ['slack xo', 'xp-1234-5678-abcdEFGH'].join(''), 'slack [secret masked]'],
    ['padded JWT', 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0=.c2lnbmF0dXJl=', 'jwt [token masked]'],
    ['unsigned JWT', 'jwt eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0. ok', 'jwt [token masked] ok'],
    [
      'Basic auth',
      'Authorization: Basic dXNlcjpwYXNzd29yZA==',
      'Authorization: Basic [token masked]',
    ],
    [
      'password in a query',
      'login?user=jo&password=hunter2&x=1',
      'login?user=jo&password=[secret masked]&x=1',
    ],
    ['api key setting', 'api_key: abc123', 'api_key: [secret masked]'],
    ['apiKey in JSON', '{"apiKey": "abc123", "n": 1}', '{"apiKey": "[secret masked]", "n": 1}'],
    [
      'tokens in JSON',
      '{"access_token":"Zk3x","refresh_token":"Rr9"}',
      '{"access_token":"[secret masked]","refresh_token":"[secret masked]"}',
    ],
    ['client secret', 'client_secret=s3cr3t', 'client_secret=[secret masked]'],
    ['passwd', 'PASSWD = letmein', 'PASSWD = [secret masked]'],
  ])('masks a %s', (_name, input, expected) => {
    expect(maskBuiltIn(input)).toBe(expected);
  });

  it.each([
    ['token word in prose', 'Refreshing the token now'],
    ['tokens count', 'tokens: 5'],
    ['secretary field', 'secretary=Jo'],
    ['basic in prose', 'a basic example of Flutter'],
    ['Bearer header stays readable', 'authorization: Bearer [token masked]'],
  ])('leaves a %s alone', (_name, input) => {
    expect(maskBuiltIn(input)).toBe(input);
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
      'password='.repeat(455),
      '"token":"'.repeat(455),
      ['AK', 'IA'].join('').repeat(1024),
      ['gh', 'p_'].join('').repeat(1024),
      ['xo', 'xb-'].join('').repeat(819),
      'eyJa.'.repeat(819),
      'Basic '.repeat(682),
      '%40a.'.repeat(819),
    ];
    const start = performance.now();
    for (const line of lines) maskBuiltIn(line);
    expect(performance.now() - start).toBeLessThan(200);
  });

  it.each([
    'eyJa-',
    'eyJa.',
    'a',
    'a%40',
    'a@',
    'http://a:',
    'ws://a/',
    'password ',
    'password=',
    '"token":"',
    '0',
    '+1-',
    '1 ',
    ['AK', 'IA'].join(''),
    ['gh', 'p_'].join(''),
    ['xo', 'xb-'].join(''),
    'Basic ',
    'Bearer ',
    'aB3/',
    'f0',
    'http%3A%2F%2F',
    'ws%253A%252F%252Fa%2F',
    '%3Dws%253A%252F%252Fa%253D',
    'http://a/?u=http%3A%2F%2Fa%2F',
    'http://a/u%3Dhttp%253A%252F%252Fa%252F%2526',
    'ws%25253A%25252F%25252Fa%25253D',
    '%3Dhttp%25253A%25252F%25252Fa%25252F%252526',
  ])('runs every built-in in linear time on 64 kB of %j', (unit) => {
    // Compared with 8 kB of the same text, not with the clock, so a busy machine doesn't
    // fail it: linear work grows 8x, quadratic work 64x. The best of three runs drops
    // pauses from garbage collection or other processes.
    const time = (size: number) => {
      const text = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 3; run++) {
        const start = performance.now();
        maskBuiltIn(text);
        best = Math.min(best, performance.now() - start);
      }
      return best;
    };
    const small = time(8_192);
    const large = time(65_536);
    // A floor on the small time, so timer resolution can't make the ratio meaningless.
    expect(large / Math.max(small, 0.5)).toBeLessThan(24);
    expect(large).toBeLessThan(2000);
  });
});

describe('credentials after a known header or key', () => {
  it.each([
    ['Authorization: Basic dXNlcjpwYXNz', 'Authorization: Basic [token masked]'],
    ['authorization:basic   abcdefgh', 'authorization:basic   [token masked]'],
    ['"Authorization": "Basic Zm9vOmJhcg"', '"Authorization": "Basic [token masked]"'],
  ])('always masks the value after Authorization: Basic (%j)', (input, expected) => {
    expect(maskBuiltIn(input)).toBe(expected);
  });

  it.each([
    ['{"password":"my secret pass"}', '{"password":"[secret masked]"}'],
    ["password='hunter 2' ok", "password='[secret masked]' ok"],
    ['{"token": "a,b;c}d"}', '{"token": "[secret masked]"}'],
    ['password=[abc123]', 'password=[secret masked]'],
    ['secret: [masked-ish] x', 'secret: [secret masked] x'],
  ])('masks a whole quoted or bracketed value (%j)', (input, expected) => {
    expect(maskBuiltIn(input)).toBe(expected);
  });

  it.each(['"token": "[token masked]"', 'password=[email masked]', 'secret=[secret masked]'])(
    'leaves a value it masked already (%j)',
    (input) => {
      expect(maskBuiltIn(input)).toBe(input);
    },
  );

  it.each([
    ['aws_secret_access_key = wJalrXUtnFEMI/K7MDENG', 'aws_secret_access_key = [secret masked]'],
    ['AWS_SECRET_ACCESS_KEY=abc', 'AWS_SECRET_ACCESS_KEY=[secret masked]'],
    ['access_key: abc', 'access_key: [secret masked]'],
    ['secretKey=abc', 'secretKey=[secret masked]'],
    ['{"private_key":"-----BEGIN KEY-----"}', '{"private_key":"[secret masked]"}'],
    ['api_secret=abc', 'api_secret=[secret masked]'],
    ['client-key: abc', 'client-key: [secret masked]'],
  ])('masks the value of more secret key names (%j)', (input, expected) => {
    expect(maskBuiltIn(input)).toBe(expected);
  });
});

describe('auth codes in encoded URLs', () => {
  it.each([
    ['ws://127.0.0.1:53211/ws?auth=X7mQ2pLk9aB%3D', 'ws://127.0.0.1:53211/[auth code masked]'],
    ['http://127.0.0.1:40229/Vt6jT5lXFNM%3D/', 'http://127.0.0.1:40229/[auth code masked]'],
    ['https://example.com/cb?code=AbCdEf12Gh%3D%3D', 'https://example.com/[auth code masked]'],
  ])('decodes the path and query before looking (%j)', (input, expected) => {
    expect(maskBuiltIn(input)).toBe(expected);
  });

  it('copes with a broken escape', () => {
    expect(maskBuiltIn('http://127.0.0.1:1/a%E0%A4%A/b')).toBe('http://127.0.0.1:1/a%E0%A4%A/b');
  });
});

describe('auth codes in URLs inside URLs', () => {
  it.each([
    [
      'DevTools link to a VM service',
      'Open http://127.0.0.1:9100/?uri=http%3A%2F%2F127.0.0.1%3A50123%2FAb3dE_fGh1I%3D%2F now',
      'Open http://127.0.0.1:9100/[auth code masked] now',
    ],
    [
      'DevTools link to a DTD WebSocket',
      'http://127.0.0.1:9100/?dtd=ws%3A%2F%2F127.0.0.1%3A53211%2Fq8ZtYb2Wd4Kx',
      'http://127.0.0.1:9100/[auth code masked]',
    ],
  ])('masks a %s', (_name, input, expected) => {
    expect(maskBuiltIn(input)).toBe(expected);
  });

  it('leaves a link to an ordinary page alone', () => {
    const text = 'http://127.0.0.1:9100/?page=http%3A%2F%2Fexample.com%2Fdocs%2Fintro';
    expect(maskBuiltIn(text)).toBe(text);
  });
});

describe('encoded URLs with no URL around them', () => {
  it.each([
    ['dtd=ws%3A%2F%2F127.0.0.1%3A61234%2FAb3dE_fGh1I%3D%2Fws', 'dtd=[auth code masked]'],
    [
      'GET /devtools?uri=http%3A%2F%2F127.0.0.1%3A50123%2FAb3dE_fGh1I%3D%2F',
      'GET /devtools?uri=[auth code masked]',
    ],
    [
      'uri=http%253A%252F%252F127.0.0.1%253A50123%252FAb3dE_fGh1I%253D%252F&x=1',
      'uri=[auth code masked]&x=1',
    ],
    ['WSS%3a%2f%2f127.0.0.1%3a1%2fq8ZtYb2Wd4Kx end', '[auth code masked] end'],
  ])('masks the encoded VM service or DTD URI in %j', (input, expected) => {
    expect(maskBuiltIn(input)).toBe(expected);
  });

  it('leaves an encoded link to an ordinary page alone', () => {
    const text = 'next=https%3A%2F%2Fexample.com%2Fdocs%2Fintro';
    expect(maskBuiltIn(text)).toBe(text);
  });
});

describe('auth codes in twice-encoded URIs', () => {
  // Built at runtime so no auth-code-shaped literal sits in the source.
  const code = ['Ab3dE', '_fGh1I'].join('');
  const vmUri = `http://127.0.0.1:50123/${code}=/`;
  const dtdUri = `ws://127.0.0.1:50124/${code}Xy9`;
  const enc = encodeURIComponent;
  const MASKED = '[auth code masked]';

  it.each([
    [
      'VM service URI, standalone',
      `GET /devtools?uri=${enc(enc(vmUri))}`,
      `GET /devtools?uri=${MASKED}`,
    ],
    [
      'VM service URI, in a full URL',
      `http://127.0.0.1:9100/devtools?uri=${enc(enc(vmUri))}&x=1`,
      `http://127.0.0.1:9100/${MASKED}`,
    ],
    ['DTD URI, standalone', `GET /devtools?dtd=${enc(enc(dtdUri))}`, `GET /devtools?dtd=${MASKED}`],
    [
      'DTD URI, in a full URL',
      `http://localhost:9100/?dtd=${enc(enc(dtdUri))}`,
      `http://localhost:9100/${MASKED}`,
    ],
    [
      'encoded query in a query value',
      `GET /login?next=${enc(`/devtools?uri=${enc(vmUri)}`)}`,
      `GET /login?next=%2Fdevtools%3Furi%3D${MASKED}`,
    ],
    [
      'encoded query, DTD',
      `GET /x?q=${enc(`a=1&uri=${enc(dtdUri)}`)}`,
      `GET /x?q=a%3D1%26uri%3D${MASKED}`,
    ],
    [
      'encoded query in a full URL',
      `http://localhost:9100/login?next=${enc(`/devtools?uri=${enc(vmUri)}`)}`,
      `http://localhost:9100/${MASKED}`,
    ],
    [
      'encoded query, DTD, in a full URL',
      `http://localhost:9100/login?next=${enc(`/devtools?uri=${enc(dtdUri)}`)}`,
      `http://localhost:9100/${MASKED}`,
    ],
    [
      'encoded query in a URL path',
      `http://localhost:9100/${enc(`devtools?uri=${enc(vmUri)}`)}`,
      `http://localhost:9100/${MASKED}`,
    ],
  ])('masks the auth code of a %s', (_name, input, expected) => {
    expect(maskBuiltIn(input)).toBe(expected);
  });

  it('masks a URL whose path and query are longer than the part it reads (R1)', () => {
    // An 8.4 kB JWT-shaped state value pushes the VM service URI past the cap.
    const part = (length: number) => `eyJ${'a'.repeat(length)}`;
    const jwt = [part(4_200), part(4_200), 'sig'].join('.');
    const text = `http://localhost:9100/cb?state=${jwt}&uri=${vmUri}`;
    expect(maskBuiltIn(text)).toBe(`http://localhost:9100/${MASKED}`);
  });

  it('masks a bare encoded URI longer than the part it reads (R1)', () => {
    const text = `uri=${enc(`http://127.0.0.1:50123/?j=${'a'.repeat(9_000)}&c=${code}=`)} end`;
    const out = maskBuiltIn(text);
    expect(out).toBe(`uri=${MASKED} end`);
  });

  it.each([
    `https://shop.example.com/cart?return=${enc('/checkout?step=review&note=thanks=')}`,
    `https://example.com/go?to=${enc('/page/section==')}`,
    `https://example.com/go?to=${enc('/a?x=1&flag=enabled=')}`,
  ])('leaves an ordinary link with = signs in an encoded value alone (R2): %s', (text) => {
    expect(maskBuiltIn(text)).toBe(text);
  });

  it('leaves a twice-encoded link to an ordinary page alone', () => {
    const page = 'https://example.com/docs/intro';
    for (const text of [
      `next=${enc(`/devtools?page=${enc(page)}`)}`,
      `http://localhost:9100/login?next=${enc(`/devtools?page=${enc(page)}`)}`,
    ]) {
      expect(maskBuiltIn(text)).toBe(text);
    }
  });
});
