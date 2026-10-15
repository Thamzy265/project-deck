/**
 * Built-in masking for text sent to Claude (design D4). Best effort: it finds common
 * shapes of emails, phone numbers, tokens and secrets, never names, addresses or free
 * text. Every pattern is bounded or anchored by a fixed character, so a 4 kB line can't
 * make it backtrack for long; these run on the main thread without a time budget.
 */

interface Pattern {
  re: RegExp;
  /**
   * `groups` are the capture groups, in order (undefined when a group didn't take part);
   * `before` and `after` are the text around the match.
   */
  replace: (match: string, groups: (string | undefined)[], before: string, after: string) => string;
}

const EMAIL = '[email masked]';
const PHONE = '[phone masked]';
const TOKEN = '[token masked]';
const SECRET = '[secret masked]';
const AUTH_CODE = '[auth code masked]';

const marker = (text: string) => () => text;

/** A run of digits and separators that looks like a phone number, checked further below. */
function isPhoneLike(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '').length;
  if (digits < 9 || digits > 15) return false;
  const international = candidate.startsWith('+');
  // Dates (2026-10-14 12…) and dotted numbers (IP addresses, versions) aren't phones.
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(candidate)) return false;
  if (!international && candidate.includes('.')) return false;
  // A bare digit run is usually an id or a timestamp; national numbers start with 0.
  if (!international && /^\d+$/.test(candidate)) return candidate.startsWith('0');
  return true;
}

/** Random-looking: upper and lower case letters and several digits, as keys are. */
function isSecretLike(candidate: string): boolean {
  return (
    /[A-Z]/.test(candidate) && /[a-z]/.test(candidate) && (candidate.match(/\d/g)?.length ?? 0) >= 3
  );
}

/**
 * A file or package path, not base64 that happens to hold a '/': it follows package:,
 * dart: or file:, ends in a file extension, or has a plain lower-case folder name.
 */
function isPathLike(candidate: string, before: string, after: string): boolean {
  if (!candidate.includes('/')) return false;
  if (/(?:package|dart|file):$/.test(before)) return true;
  if (/^\.[a-z]{1,5}\b/.test(after)) return true;
  return candidate.split('/').some((segment) => /^[a-z_]{2,}$/.test(segment));
}

const LOOPBACK = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;

/**
 * Longest URL path or query looked at for auth codes. Each level of decoding and nesting
 * walks it again, so the cap keeps the work per URL small. A longer one is treated as
 * holding an auth code (fails closed), since the part past the cap is never read.
 */
const MAX_URL_PART = 8192;

const SEPARATORS = /[/?#&]/;

/**
 * Every path segment and query value, as written and after each of up to
 * DECODE_ROUNDS rounds of decoding: a URI encoded inside another encoded value (%253A,
 * or %3Furi%3D…) hides its separators and padding otherwise.
 *
 * `own` holds the segments and their query values themselves, where padded base64 is an
 * auth code. `nested` adds the pieces of a decoded value split again (decoding may have
 * turned %3F, %3D and %26 into separators); they only count as a URL to look inside, as
 * `section==` in an ordinary encoded link `%2Fpage%2Fsection%3D%3D` is not a code.
 */
function urlParts(path: string): { own: string[]; nested: string[] } {
  const own = new Set<string>();
  const nested = new Set<string>();
  const add = (set: Set<string>, piece: string) => {
    if (piece === '') return;
    const eq = piece.indexOf('=');
    set.add(uncut(piece));
    if (eq > 0 && eq < piece.length - 1) set.add(uncut(piece.slice(eq + 1)));
  };
  for (const segment of path.split(SEPARATORS)) {
    if (segment === '') continue;
    for (const text of decodings(segment)) {
      add(own, text);
      for (const piece of [...text.split(/[?#&]/), ...text.split(SEPARATORS)]) add(nested, piece);
    }
  }
  return { own: [...own], nested: [...own, ...nested] };
}

/**
 * Rounds of percent-decoding tried, in URLs and in bare encoded URIs alike; the bare
 * pattern allows the matching number of %25 prefixes (DECODE_ROUNDS - 1).
 */
const DECODE_ROUNDS = 3;

/** The text and up to DECODE_ROUNDS rounds of percent-decoding it. */
function decodings(text: string): string[] {
  const out = [text];
  let current = text;
  for (let round = 0; round < DECODE_ROUNDS && /%[0-9a-f]{2}/i.test(current); round++) {
    const next = decode(current);
    if (next === current) break;
    out.push(next);
    current = next;
  }
  return out;
}

const INNER_URL = /^(?:https?|wss?):\/\/(?:[^/?#@]*@)?([^/?#]+)(.*)$/is;

/**
 * A path segment that is an auth code: base64 with padding (VM service, DTD), or on a
 * loopback host any random-looking first segment (a DTD secret without padding).
 */
function hasAuthCode(host: string, path: string, depth = 0): boolean {
  if (path.length > MAX_URL_PART) return true;
  const { own, nested } = urlParts(path);
  if (own.some((s) => /^[A-Za-z0-9+_-]{6,}={1,2}$/.test(s))) return true;
  // A URL passed as a value, such as DevTools' ?uri=<VM service URI>: look inside it too.
  if (depth < 2) {
    for (const candidate of nested) {
      const inner = INNER_URL.exec(candidate);
      if (inner !== null && hasAuthCode(inner[1] ?? '', inner[2] ?? '', depth + 1)) return true;
    }
  }
  const first = path
    .split(SEPARATORS)
    .map(uncut)
    .find((s) => s !== '');
  if (!LOOPBACK.test(host) || first === undefined || !/^[A-Za-z0-9+_-]{8,}$/.test(first)) {
    return false;
  }
  return isSecretLike(first) || (LOOPBACK_PORT.test(host) && isRandomSegment(first));
}

const LOOPBACK_PORT = /:\d+$/;

/**
 * Parts of a route that are words even though they hold digits or capitals: version
 * tags and common abbreviations. Matched against a whole part between `-`, `_` or `+`.
 */
const ROUTE_WORDS =
  /^(?:v\d{1,3}|i18n|l10n|a11y|utf8|md5|sha\d{1,3}|base64|x64|x86|arm64|oauth2|http2|h2|[23]d|mp[34]|h26[45])$/i;

/**
 * Humps of a camelCase or snake_case word: an acronym, a word with an optional capital,
 * or a digit run. Each alternative is greedy with one fixed lookahead, so it is linear.
 */
const HUMP = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g;

/**
 * Review N2: a VM service or DTD code on a loopback port without padding and with few
 * digits, such as `Ab3dE_fGh1I`. The first path segment (8+ base64url characters, as
 * checked by the caller) is random-looking when:
 * - it has both upper and lower case letters, or a digit; and
 * - some part between `-`, `_` or `+` is not word-shaped. A part is word-shaped when it
 *   is all digits (an id), is in ROUTE_WORDS, or splits into humps where every letter
 *   hump is at least 3 characters (2 for the first one, as in `myRoute`), every acronym
 *   at least 2, and digit runs of at most 2 follow a word (`oauth2callback`).
 * So `/api/status`, `/devtools/`, `/DevTools`, `/getUserProfile`, `/12345678` stay as
 * they are; anything with a `.` (`main.dart.js`) never gets here.
 */
function isRandomSegment(segment: string): boolean {
  const mixedCase = /[A-Z]/.test(segment) && /[a-z]/.test(segment);
  if (!mixedCase && !/\d/.test(segment)) return false;
  return segment.split(/[-_+]/).some((part) => part !== '' && !isWordShaped(part));
}

function isWordShaped(part: string): boolean {
  if (/^\d+$/.test(part) || ROUTE_WORDS.test(part)) return true;
  const humps = part.match(HUMP) ?? [];
  return humps.every((hump, index) => {
    if (/^\d/.test(hump))
      return index > 0 && hump.length <= 2 && !/^\d/.test(humps[index - 1] ?? '');
    if (/^[A-Z]+$/.test(hump)) return hump.length >= 2;
    return hump.length >= (index === 0 ? 2 : 3);
  });
}

/** Without an escape cut short at the end (`%`, `%2`), as when a logger cuts the line. */
function uncut(text: string): string {
  return text.replace(/%[0-9A-Fa-f]?$/, '');
}

const ESCAPE_RUN = /(?:%[0-9A-Fa-f]{2})+/g;

/**
 * Percent-decoding that keeps an invalid or cut escape as written. decodeURIComponent
 * gives up on the whole text for one bad escape (a line cut inside one, a Latin-1 %E9),
 * which would leave every other escape, and any auth code behind them, unread.
 */
function decode(text: string): string {
  return text.replace(ESCAPE_RUN, decodeRun);
}

/**
 * Decodes the valid UTF-8 in a run of escapes and keeps each invalid escape as written.
 * The bytes are checked by hand in one pass, so decodeURIComponent only ever sees valid
 * stretches and never throws: an exception per broken escape made long runs of them
 * (%E9%E9…) many times slower than valid ones (review N1).
 */
function decodeRun(run: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < run.length; i += 3) bytes.push(parseInt(run.slice(i + 1, i + 3), 16));
  let out = '';
  let valid = 0; // first byte of the valid stretch not yet decoded
  let i = 0;
  const flush = (end: number) => {
    if (end > valid) out += decodeURIComponent(run.slice(valid * 3, end * 3));
  };
  while (i < bytes.length) {
    const size = utf8Size(bytes, i);
    if (size > 0) {
      i += size;
      continue;
    }
    flush(i);
    out += run.slice(i * 3, i * 3 + 3);
    i += 1;
    valid = i;
  }
  flush(i);
  return out;
}

/** The length of the valid UTF-8 sequence starting at `i`, or 0 (RFC 3629, table 3-7). */
function utf8Size(bytes: number[], i: number): number {
  const lead = bytes[i] ?? 0x100;
  if (lead < 0x80) return 1;
  let size: number;
  let low = 0x80;
  let high = 0xbf;
  if (lead >= 0xc2 && lead <= 0xdf) size = 2;
  else if (lead >= 0xe0 && lead <= 0xef) {
    size = 3;
    if (lead === 0xe0) low = 0xa0; // overlong
    if (lead === 0xed) high = 0x9f; // surrogates
  } else if (lead >= 0xf0 && lead <= 0xf4) {
    size = 4;
    if (lead === 0xf0) low = 0x90; // overlong
    if (lead === 0xf4) high = 0x8f; // above U+10FFFF
  } else return 0;
  for (let k = 1; k < size; k++) {
    const byte = bytes[i + k];
    if (byte === undefined || byte < (k === 1 ? low : 0x80) || byte > (k === 1 ? high : 0xbf)) {
      return 0;
    }
  }
  return size;
}

/**
 * VM service and DTD URIs carry their auth code in the path, and anyone holding one can
 * drive the app. Keeps scheme, host and port so the line still says where it pointed.
 */
function maskUrl(match: string, groups: (string | undefined)[]): string {
  const [userinfo, host = '', path = ''] = groups;
  const scheme = match.slice(0, match.indexOf('://'));
  const who = userinfo === undefined ? '' : `${AUTH_CODE}@`;
  if (hasAuthCode(host, path)) return `${scheme}://${who}${host}/${AUTH_CODE}`;
  return userinfo === undefined ? match : `${scheme}://${who}${host}${path}`;
}

/**
 * A percent-encoded URL with no URL around it, such as a logged query value
 * `uri=http%3A%2F%2F127.0.0.1%3A50123%2FAb3dE_fGh1I%3D%2F`, encoded up to DECODE_ROUNDS times.
 * Masked whole when the decoded URL carries an auth code.
 */
function maskEncodedUrl(match: string): string {
  if (match.length > MAX_URL_PART) return AUTH_CODE;
  const url = INNER_URL.exec(decodings(match).at(-1) ?? match);
  return url !== null && hasAuthCode(url[1] ?? '', url[2] ?? '') ? AUTH_CODE : match;
}

/**
 * A bare encoded URI: the scheme, then `://` with each escape encoded up to
 * DECODE_ROUNDS times (DECODE_ROUNDS - 1 extra %25), after a word boundary or after an
 * escape encoded as many times, as `%253Dhttp%25253A…` in a twice-encoded `/?uri=`.
 */
function encodedUrlPattern(): RegExp {
  const extra = `(?:25){0,${DECODE_ROUNDS - 1}}`;
  const escape = (hex: string) => `%${extra}${hex}`;
  return new RegExp(
    `(?:(?<=%${extra}[0-9A-Fa-f]{2})|(?<![A-Za-z0-9_]))(?:https?|wss?)` +
      `${escape('3A')}${escape('2F')}${escape('2F')}[A-Za-z0-9%._~+=-]+`,
    'gi',
  );
}

const PATTERNS: Pattern[] = [
  {
    // Before the email rule, which would take user:pass@host for an address.
    re: /\b(?:https?|wss?):\/\/([^\s/?#"'<>@]*@)?([^\s/?#"'<>]+)([^\s"'<>]*)/gi,
    replace: maskUrl,
  },
  {
    // The scheme and an encoded :// anchor every match. The scheme may follow an escape
    // such as %3D, itself encoded again (%253D) when the query around the URI was
    // encoded too. The value takes the whole run, with nothing after it to backtrack
    // into; a long one fails closed.
    re: encodedUrlPattern(),
    replace: maskEncodedUrl,
  },
  {
    re: /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    // Keeps the word as written (Bearer, bearer, BEARER).
    replace: (match) => `${match.slice(0, 'bearer'.length)} ${TOKEN}`,
  },
  {
    // After an Authorization header the value is always a credential, whatever it looks like.
    re: /(\bauthorization"?\s*[:=]\s*"?basic\s+)[A-Za-z0-9+/]+={0,2}/gi,
    replace: (_match, [header = '']) => `${header}${TOKEN}`,
  },
  {
    // base64("user:password"); "basic" in prose is followed by a plain word.
    re: /\bbasic\s+([A-Za-z0-9+/]{8,}={0,2})/gi,
    replace: (match, [value = '']) =>
      /[=+/\d]/.test(value) ? `${match.slice(0, 'basic'.length)} ${TOKEN}` : match,
  },
  {
    // JSON header and payload both start with eyJ; padding kept, signature optional (alg none).
    // Not inside a longer token: \b alone let every "eyJ" in "eyJa-eyJa-…" start a scan
    // to the end of the text, which is quadratic.
    re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{2,}={0,2}\.eyJ[A-Za-z0-9_-]{2,}={0,2}\.(?:[A-Za-z0-9_-]+={0,2})?/g,
    replace: marker(TOKEN),
  },
  ...[
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, // AWS access key id
    /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g, // GitHub token
    /\bgithub_pat_[A-Za-z0-9_]{22,255}/g, // GitHub fine-grained token
    /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,247}\b/g, // Stripe secret or restricted key
    /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, // Google API key
    /\bxox[abprs]-[A-Za-z0-9-]{10,250}/g, // Slack token
  ].map((re) => ({ re, replace: marker(SECRET) })),
  {
    // %40 is a URL-encoded @, as HTTP loggers print query strings.
    re: /[A-Za-z0-9._%+-]{1,64}(?:@|%40)(?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,24}\b/g,
    // name@2x.png is a Flutter asset variant, not an address.
    replace: (match) => (/(?:@|%40)\d+(?:\.\d+)?x\./.test(match) ? match : EMAIL),
  },
  {
    // The value after a secret-sounding key, in key=value, key: value and "key":"value"
    // forms. An auth scheme word and a value masked already are left as they are.
    re: /(?<![A-Za-z0-9])((?:aws[_-]?)?secret[_-]?access[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|api[_-]?secret|client[_-]?key|password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization)("?\s*[:=]\s*)(?!["']?(?:bearer|basic)\s)(?!["']?\[(?:email|phone|token|secret|auth code) masked\])(?:"[^"\n]{1,256}(?=")|'[^'\n]{1,256}(?=')|["']?[^\s"',;&}]{1,256})/gi,
    // A quoted value is masked up to its closing quote; the quotes stay.
    replace: (match, [key = '', separator = '']) => {
      const first = match.charAt(key.length + separator.length);
      const quote = first === '"' || first === "'" ? first : '';
      return `${key}${separator}${quote}${SECRET}`;
    },
  },
  {
    // Digits and letters both: a hash or key, not a run of 'a's or a long number.
    re: /\b[0-9a-fA-F]{32,}\b/g,
    replace: (match) => (/\d/.test(match) && /[a-f]/i.test(match) ? SECRET : match),
  },
  {
    re: /[A-Za-z0-9+/_-]{32,}={0,2}/g,
    replace: (match, _groups, before, after) =>
      isSecretLike(match) && !isPathLike(match, before, after) ? SECRET : match,
  },
  {
    re: /(?<![\w+.])\+?(?:\(\d{1,4}\)|\d)[\d ().-]{6,20}\d(?![\w.])/g,
    replace: (match) => (isPhoneLike(match) ? PHONE : match),
  },
];

/** Replaces every built-in match in `text` with a marker that says what was masked. */
export function maskBuiltIn(text: string): string {
  let out = text;
  for (const { re, replace } of PATTERNS) {
    // Without named groups the replacer gets (match, ...groups, offset, whole).
    out = out.replace(re, (match: string, ...args: unknown[]) => {
      const offset = args.at(-2) as number;
      const whole = args.at(-1) as string;
      return replace(
        match,
        args.slice(0, -2) as (string | undefined)[],
        whole.slice(Math.max(0, offset - 16), offset),
        whole.slice(offset + match.length, offset + match.length + 16),
      );
    });
  }
  return out;
}
