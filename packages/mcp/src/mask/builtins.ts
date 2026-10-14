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
 * A path segment that is an auth code: base64 with padding (VM service, DTD), or on a
 * loopback host any random-looking first segment (a DTD secret without padding).
 */
function hasAuthCode(host: string, path: string): boolean {
  const segments = path.split(/[/?#&]/).filter((s) => s !== '');
  // Each path segment and query value, decoded: %3D hides the padding otherwise.
  const candidates = segments.flatMap((s) => {
    const eq = s.indexOf('=');
    const value = eq > 0 && eq < s.length - 1 ? [s.slice(eq + 1)] : [];
    return [s, ...value].map(decode);
  });
  if (candidates.some((s) => /^[A-Za-z0-9+_-]{6,}={1,2}$/.test(s))) return true;
  const first = segments[0];
  return (
    LOOPBACK.test(host) &&
    first !== undefined &&
    /^[A-Za-z0-9+_-]{8,}$/.test(first) &&
    isSecretLike(first)
  );
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
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

const PATTERNS: Pattern[] = [
  {
    // Before the email rule, which would take user:pass@host for an address.
    re: /\b(?:https?|wss?):\/\/([^\s/?#"'<>@]*@)?([^\s/?#"'<>]+)([^\s"'<>]*)/gi,
    replace: maskUrl,
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
