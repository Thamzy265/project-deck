/**
 * Tester probes of the masking hardening (design D4, review N1 and N2): broken UTF-8 in
 * escape runs, unpadded auth codes on a loopback port, real local routes that must stay
 * as they are, and encoded URIs with mixed-case hex. Known misses are `it.fails` repros
 * with a bug id from the tester report.
 *
 * Code shape: DDS `_makeAuthToken()` (dds 5.3.0, lib/src/dds_impl.dart) is
 * `base64Url.encode` of 8 random bytes, so 12 characters with one `=`; without the
 * padding it is 11 base64url characters.
 */
import { describe, expect, it } from 'vitest';
import { maskBuiltIn } from './builtins.js';

// Built at runtime so no auth-code-shaped literal sits in the source.
const code = ['Ab3dE', '_fGh1I'].join('');
const padded = ['qXHgMx0R', 'Rm4%3D'].join('');
const MASKED = '[auth code masked]';
const enc = encodeURIComponent;

function hidesCode(text: string, secret: string): void {
  const out = maskBuiltIn(text);
  expect(out).not.toContain(secret);
  expect(out).toContain(MASKED);
}

/** Deterministic 8-byte codes (mulberry32), base64url without padding, as DDS makes them. */
function unpaddedCodes(count: number, seed: number): string[] {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % 256;
  };
  return Array.from({ length: count }, () =>
    Buffer.from(Array.from({ length: 8 }, next)).toString('base64url'),
  );
}

describe('broken UTF-8 next to an auth code (N1)', () => {
  // Each one must be kept as written, and must not stop the escapes around it decoding.
  const broken = [
    ['overlong 2-byte', '%C0%AF'],
    ['overlong 3-byte', '%E0%80%AF'],
    ['overlong 4-byte', '%F0%8F%BF%BF'],
    ['high surrogate', '%ED%A0%80'],
    ['low surrogate', '%ED%BF%BF'],
    ['CESU-8 pair', '%ED%A0%BD%ED%B8%80'],
    ['above U+10FFFF', '%F4%90%80%80'],
    ['F5 lead', '%F5%80%80%80'],
    ['FF byte', '%FF'],
    ['lone continuation', '%80'],
    ['cut 3-byte', '%E2%82'],
    ['cut 4-byte', '%F0%9F%98'],
    ['valid then invalid', '%C3%A9%E9%C3'],
    ['long Latin-1 run', '%E9'.repeat(50)],
  ] as const;

  it.each(broken)('masks a bare encoded URI after a %s segment', (_name, junk) => {
    hidesCode(`x http%3A%2F%2F127.0.0.1%3A1%2F${junk}%2F${padded}%2F `, padded);
  });

  it.each(broken)('masks a bare encoded URI before a %s segment', (_name, junk) => {
    hidesCode(`x http%3A%2F%2F127.0.0.1%3A1%2F${code}%2F${junk} `, code);
  });

  it.each(broken)('masks a ?uri= value after a %s path segment', (_name, junk) => {
    hidesCode(`http://127.0.0.1:1/${junk}/?uri=http%3A%2F%2F127.0.0.1%3A1%2F${padded}`, padded);
  });

  it.each(broken)('masks a twice-encoded ?uri= value next to %s', (_name, junk) => {
    const twice = junk.replaceAll('%', '%25');
    hidesCode(
      `http://127.0.0.1:1/?a=${junk}&uri=http%253A%252F%252F127.0.0.1%253A1%252F${code}%252F${twice}`,
      code,
    );
  });

  it.each([
    ['the largest code point', '%F4%8F%BF%BF'],
    ['the last code point before the surrogates', '%ED%9F%BF'],
    ['a byte order mark', '%EF%BB%BF'],
    ['an emoji', '%F0%9F%98%80'],
  ])('decodes %s and still masks the code after it', (_name, valid) => {
    hidesCode(`x http%3A%2F%2F127.0.0.1%3A1%2F${valid}%2F${padded}%2F `, padded);
  });

  it.each([
    'x http%3A%2F%2F127.0.0.1%2F' + '%F0%90%80'.repeat(30) + ' ',
    'x http%3A%2F%2F127.0.0.1%2F' + '%ED%A0%80'.repeat(30) + ' ',
    'http://127.0.0.1:1/' + '%F4%90'.repeat(40) + ' ',
    'http://127.0.0.1:1/?u=' + '%25ED%25A0'.repeat(40) + ' ',
  ])('stays linear on 64 kB of %j', (unit) => {
    // 8x the text should cost about 8x; quadratic work would be 64x.
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
    expect(time(65_536) / Math.max(time(8_192), 0.5)).toBeLessThan(24);
  });
});

describe('unpadded auth codes on a loopback port (N2)', () => {
  it.each([
    ['upper-case LOCALHOST', `ws://LOCALHOST:50123/${code}/ws`],
    ['mixed-case host', `ws://LocalHost:50123/${code}/ws`],
    ['IPv6 loopback', `ws://[::1]:50123/${code}/ws`],
    ['a query right after the host', `http://127.0.0.1:50123/?${code}`],
    ['a fragment right after the host', `http://127.0.0.1:50123/#${code}`],
    ['userinfo', `http://user@127.0.0.1:50123/${code}`],
  ])('masks a code with %s', (_name, text) => {
    hidesCode(text, code);
  });

  it.each([
    ['lower-case hex', (s: string) => s.replace(/%[0-9A-F]{2}/g, (e) => e.toLowerCase())],
    [
      'mixed-case hex',
      (s: string) => {
        let i = 0;
        return s.replace(/%[0-9A-F]{2}/g, (e) => (i++ % 2 === 0 ? e : e.toLowerCase()));
      },
    ],
  ])('masks encoded and twice-encoded URIs written in %s', (_name, recase) => {
    const vm = `http://127.0.0.1:50123/${code}/`;
    for (const text of [
      `x ${enc(vm)} `,
      `x ${enc(enc(enc(vm)))} `,
      `GET /?a=1&uri=${enc(enc(vm))}`,
      `next=${enc(enc(`/?uri=${enc(vm)}`))}`,
      `next=${enc(`/?uri=${enc(enc(vm))}`)}`,
    ]) {
      hidesCode(recase(text), code);
    }
  });

  it('masks every padded 8-byte code (regression lock)', () => {
    const missed = unpaddedCodes(2000, 1).filter((c) => {
      const text = `ws://127.0.0.1:50123/${c}=/ws`;
      return maskBuiltIn(text).includes(c);
    });
    expect(missed).toEqual([]);
  });

  // N2-U1: about 1 in 27 unpadded 8-byte codes used to be read as word-shaped and leak.
  it('N2-U1: masks every unpadded 8-byte code', () => {
    const missed = unpaddedCodes(2000, 1).filter((c) => {
      const text = `ws://127.0.0.1:50123/${c}/ws`;
      return maskBuiltIn(text).includes(c);
    });
    expect(missed).toEqual([]);
  });

  it.each([
    ['no digits', ['Phcpaen', 'ppMQ']],
    ['one digit inside the humps', ['MuRMQ3E', 'gqh0']],
    ['humps split by _', ['dxurYJK', '_auk']],
    ['a leading - and a 2-digit tail', ['-ljirtj', 'ic50']],
  ])('N2-U1: masks the unpadded code with %s', (_name, parts) => {
    const secret = parts.join('');
    hidesCode(`ws://127.0.0.1:50123/${secret}/ws`, secret);
  });

  // N2-U2: loopback forms the rule used to miss (it named 127.0.0.1, localhost, [::1]).
  it.each([
    ['127.0.0.2', `ws://127.0.0.2:50123/${code}/ws`],
    ['0.0.0.0', `ws://0.0.0.0:50123/${code}/ws`],
    ['long IPv6 loopback', `ws://[0:0:0:0:0:0:0:1]:50123/${code}/ws`],
    ['IPv4-mapped IPv6', `ws://[::ffff:127.0.0.1]:50123/${code}/ws`],
    ['localhost with a trailing dot', `ws://localhost.:50123/${code}/ws`],
  ])('N2-U2: masks a code on %s', (_name, text) => {
    hidesCode(text, code);
  });

  // I3-1: a fourth level of encoding is past DECODE_ROUNDS; it used to be neither read
  // nor failed closed.
  it('I3-1: masks a four-times-encoded VM service URI', () => {
    hidesCode(`x ${enc(enc(enc(enc(`http://127.0.0.1:50123/${padded}/`))))} `, 'qXHgMx0RRm4');
  });
});

describe('real local routes stay as they are (N2)', () => {
  // Chrome DevTools protocol, DevTools pages, Dart VM service methods used as paths,
  // Flutter web dev server files and App Engine style health routes.
  it.each([
    'json/version',
    'json',
    'ws',
    'getVM',
    'getVMTimeline',
    'getIsolate',
    '_getAllocationProfile',
    'getIsolateGroupMemoryUsage',
    'streamListen',
    'getCpuSamples',
    '_ah/health',
    'main.dart.js?v=abc123',
    'assets/AssetManifest.bin.json',
    'AssetManifest',
    'CHANGELOG',
    'README',
    'DartDevelopmentService',
    'devtools_extensions',
    'vm_service_ws',
    'getHTTPStatus',
    'macOSApp',
    'v1beta1',
    'webGL2Demo',
    'checkout_step2',
    'top10Items',
  ])('leaves http://127.0.0.1:8080/%s alone', (route) => {
    const text = `http://127.0.0.1:8080/${route}`;
    expect(maskBuiltIn(text)).toBe(text);
  });

  // N2-O1: these used to read as random. Only 11-character segments can be codes now.
  it.each(['order12345', 'index2024', 'README2024', 'iOSSimulator'])(
    'N2-O1: leaves http://127.0.0.1:8080/%s alone',
    (route) => {
      const text = `http://127.0.0.1:8080/${route}`;
      expect(maskBuiltIn(text)).toBe(text);
    },
  );

  // N2-O1, known over-mask accepted by the lead (15 Oct 2026) as failing closed: an
  // 11-character route with mixed case or a digit has the shape of an unpadded code.
  it('N2-O1: masks http://127.0.0.1:8080/iPhone15Pro (known over-mask)', () => {
    expect(maskBuiltIn('http://127.0.0.1:8080/iPhone15Pro')).toBe(
      `http://127.0.0.1:8080/${MASKED}`,
    );
  });
});
