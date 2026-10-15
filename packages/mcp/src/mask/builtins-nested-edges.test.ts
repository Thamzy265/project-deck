/**
 * Tester probes of auth codes in URIs encoded inside encoded values (design D4): other
 * nestings, hex case, malformed escapes, the 8 kB part cap and ordinary links that must
 * stay as they are. Known leaks are `it.fails` repros with a bug id from the tester report.
 * URI shapes follow DevTools' `?uri=` and `?dtd=` query values.
 */
import { describe, expect, it } from 'vitest';
import { growth } from '../testing/timing.js';
import { maskBuiltIn } from './builtins.js';

// Built at runtime so no auth-code-shaped literal sits in the source.
const code = ['Ab3dE', '_fGh1I'].join('');
const vmUri = `http://127.0.0.1:50123/${code}=/`;
const dtdUri = `ws://127.0.0.1:50124/${code}Xy9`;
const enc = encodeURIComponent;
const lowerHex = (text: string) => text.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
const MASKED = '[auth code masked]';

function hidesCode(text: string): void {
  const out = maskBuiltIn(text);
  expect(out).not.toContain(code);
  expect(out).toContain(MASKED);
}

describe('auth codes in an encoded query inside a value', () => {
  it.each([
    ['in a fragment', `http://localhost:9100/#/login?next=${enc(`/devtools?uri=${enc(vmUri)}`)}`],
    ['with lower-case hex', `GET /login?next=${lowerHex(enc(`/devtools?uri=${enc(vmUri)}`))}`],
    [
      'with lower-case hex, in a full URL',
      `http://localhost:9100/login?next=${lowerHex(enc(`/devtools?uri=${enc(vmUri)}`))}`,
    ],
    ['of a DTD URI in a URL path', `http://localhost:9100/${enc(`devtools?dtd=${enc(dtdUri)}`)}`],
    ['after an encoded #', `GET /x?next=${enc(`/devtools#uri=${enc(vmUri)}`)}`],
    [
      'after an encoded #, in a full URL',
      `http://localhost:9100/x?next=${enc(`/devtools#uri=${enc(vmUri)}`)}`,
    ],
    ['next to + and %20 spaces', `GET /x?q=a+b&next=${enc(`/d?x=a b&uri=${enc(vmUri)}`)}`],
    ['in a JSON string', `{"next":"${enc(`/devtools?uri=${enc(vmUri)}`)}"}`],
    ['after several encoded &', `GET /x?q=${enc(`a=1&b=2&uri=${enc(vmUri)}`)}`],
    ['of a DTD URI on [::1]', `GET /x?q=${enc(`uri=${enc(`ws://[::1]:50124/${code}Xy9`)}`)}`],
  ])('masks it %s', (_name, text) => {
    hidesCode(text);
  });

  it('masks a three-times-encoded URI inside a full URL', () => {
    hidesCode(`http://localhost:9100/?uri=${enc(enc(enc(vmUri)))}`);
  });
});

describe('malformed percent escapes', () => {
  it.each([
    '%',
    '%%',
    '%zz',
    '%2',
    '%25%',
    '%E0%A4%A',
    '%C3%28',
    `http://localhost:9100/%/%zz?uri=%E0%A4%A&x=%`,
    `GET /?uri=http%253A%252F%252F%25zz%2`,
    `http%3A%2F%2F%%%3F%3D%`,
  ])('never throws on %j', (text) => {
    expect(() => maskBuiltIn(text)).not.toThrow();
    expect(maskBuiltIn(text)).toBe(text);
  });

  it('still masks a twice-encoded URI when another segment has a bad escape', () => {
    hidesCode(`http://localhost:9100/%E0%A4%A?uri=${enc(enc(vmUri))}`);
  });

  // MF-T1: one malformed escape anywhere in the value (a logger cutting the line inside
  // an escape, or a Latin-1 %E9) makes decodeURIComponent throw, so the whole value is
  // never decoded and the code stays readable. Each valid escape is now decoded on its own.
  it.each([
    ['cut after %', `GET /?uri=${enc(vmUri)}%`],
    ['cut inside %25', `GET /?uri=${enc(enc(vmUri)).slice(0, -3)}`],
    ['cut inside %2', `GET /?dtd=${enc(enc(dtdUri))}%2`],
    ['followed by %zz, in a full URL', `http://localhost:9100/?uri=${enc(enc(vmUri))}%zz`],
    ['followed by a Latin-1 escape', `GET /?uri=${enc(enc(vmUri))}%2526n%253Dcaf%25E9`],
  ])('MF-T1: masks the code when the value is %s', (_name, text) => {
    hidesCode(text);
  });
});

describe('the 8 kB cap on URL parts', () => {
  const filler = (length: number) => 'a'.repeat(length);

  it.each([8_000, 8_200, 9_000])(
    'masks a twice-encoded URI after %i characters of other query (caught as an encoded URL)',
    (length) => {
      hidesCode(`http://localhost:9100/?j=${filler(length)}&uri=${enc(enc(vmUri))}`);
    },
  );

  // MF-T2: a regression. Before the cap, a plain VM service URI anywhere in a long URL
  // was masked; a URL longer than the cap is now masked whole (fails closed).
  it.each([
    ['in the path', `http://127.0.0.1:50123/${filler(8_200)}/${code}=/`],
    ['as a ?uri= value', `http://127.0.0.1:9100/?j=${filler(8_150)}&uri=${vmUri}`],
  ])('MF-T2: masks a code that starts past 8 kB %s', (_name, text) => {
    hidesCode(text);
  });
});

describe('encodings the fix does not claim', () => {
  // MF-T3 (low): three rounds of encoding are found inside a full URL but not in a
  // bare value, where the encoded-URL pattern allowed only one %25 per escape.
  it.each([
    ['VM service URI', `GET /?uri=${enc(enc(enc(vmUri)))}`],
    ['DTD URI', `GET /?dtd=${enc(enc(enc(dtdUri)))}`],
    [
      'once-encoded query holding a twice-encoded URI',
      `GET /x?next=${enc(`/d?uri=${enc(enc(vmUri))}`)}`,
    ],
  ])('MF-T3: masks a three-times-encoded %s in a bare value', (_name, text) => {
    hidesCode(text);
  });

  // QA, 15 Oct 2026: a twice-encoded `/?uri=` wrapper puts %253D, not %3D, right before
  // the three-times-encoded scheme, so the bare pattern never started there.
  it.each([
    ['VM service URI', `next=${enc(enc(`/?uri=${enc(vmUri)}`))}`],
    ['DTD URI', `next=${enc(enc(`/?dtd=${enc(dtdUri)}`))}`],
    [
      'VM service URI, in a full URL',
      `http://localhost:9100/?next=${enc(enc(`/?uri=${enc(vmUri)}`))}`,
    ],
  ])('masks a twice-encoded /?uri= wrapper holding a %s', (_name, text) => {
    hidesCode(text);
  });

  it('leaves a twice-encoded /?page= wrapper holding an ordinary link alone', () => {
    const text = `next=${enc(enc(`/?page=${enc('https://example.com/docs/intro')}`))}`;
    expect(maskBuiltIn(text)).toBe(text);
  });

  it('masks the exact QA string', () => {
    const text = `next=%252F%253Furi%253Dhttp%25253A%25252F%25252F127.0.0.1%25253A50123%25252F${code}%25253D%25252F`;
    expect(maskBuiltIn(text)).toBe(`next=%252F%253Furi%253D${MASKED}`);
  });
});

describe('encodings deeper than DECODE_ROUNDS fail closed (I3-1)', () => {
  const enc4 = (text: string) => enc(enc(enc(enc(text))));

  it.each([
    ['a four-times-encoded VM service URI', `x ${enc4(vmUri)} end`, `x ${MASKED} end`],
    ['a four-times-encoded DTD URI', `dtd=${enc4(dtdUri)}`, `dtd=${MASKED}`],
    ['a five-times-encoded VM service URI', `x ${enc(enc4(vmUri))} end`, `x ${MASKED} end`],
    // It can't be read, so even an ordinary link is masked.
    [
      'a four-times-encoded ordinary link',
      `next=${enc4('https://example.com/docs')}`,
      `next=${MASKED}`,
    ],
  ])('masks %s', (_name, text, expected) => {
    expect(maskBuiltIn(text)).toBe(expected);
  });

  it('masks it inside a full URL', () => {
    hidesCode(`http://localhost:9100/?uri=${enc4(vmUri)}`);
  });
});

describe('ordinary nested links stay as they are', () => {
  it.each([
    [
      'an OAuth authorize URL with a nested redirect_uri',
      `https://accounts.example.com/o/oauth2/v2/auth?client_id=123.apps.example.com&redirect_uri=${enc(
        `https://app.example.com/callback?next=${enc('/home?tab=1')}`,
      )}&response_type=code&scope=openid`,
    ],
    [
      'a bare twice-encoded redirect_uri',
      `redirect_uri=${enc(enc('https://app.example.com/cb?state=xyz'))}`,
    ],
    [
      'an app deep link',
      `myapp://open?link=${enc(`https://example.com/p?ref=${enc('https://other.example.com/x')}`)}`,
    ],
    [
      'a dynamic link with a nested utm value',
      `https://example.page.link/?link=${enc(
        `https://example.com/item/42?utm_source=${enc('https://t.example.com/abc')}`,
      )}&apn=com.example`,
    ],
    [
      'a local dev server redirect',
      `http://localhost:3000/?next=${enc(enc('http://localhost:3000/home?tab=2'))}`,
    ],
  ])('keeps %s', (_name, text) => {
    expect(maskBuiltIn(text)).toBe(text);
  });
});

describe('long escape runs', () => {
  it.each([
    '%25',
    '%2525',
    'http%25253A%25252F%25252F',
    'http%253A%252F%252F%2525',
    '/%253Furi%253Dhttp%25253A%25252F%25252Fa',
    'http://127.0.0.1:1/?u=http%253A%252F%252Fa%253Fu%253D',
    '%253D%2526',
    '%253Dhttp%25253A%25252F%25252Fa%25252F ',
    '%25252525http',
    'https',
    '%2525252525253Dhttp%252525253A%252525252F%252525252Fa ',
    'http%2525252525',
    '%25253D%253D%3Dhttp%253A%252F%252F127.0.0.1%253A1%252F ',
  ])('stays linear on 64 kB of %j', (unit) => {
    // 8x the text should cost about 8x.
    const { ratio, large } = growth(maskBuiltIn, unit, 8_192, 65_536);
    expect(ratio).toBeLessThan(24);
    expect(large).toBeLessThan(2000);
  });
});
