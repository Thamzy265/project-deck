/**
 * Built-in masking for text sent to Claude (design D4). Best effort: it finds common
 * shapes of emails, phone numbers, tokens and secrets, never names, addresses or free
 * text. Every pattern is bounded or anchored by a fixed character, so a 4 kB line can't
 * make it backtrack for long; these run on the main thread without a time budget.
 */

interface Pattern {
  re: RegExp;
  /** `groups` are the capture groups, in order; undefined when a group didn't take part. */
  replace: (match: string, groups: (string | undefined)[]) => string;
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

const LOOPBACK = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;

/**
 * A path segment that is an auth code: base64 with padding (VM service, DTD), or on a
 * loopback host any random-looking first segment (a DTD secret without padding).
 */
function hasAuthCode(host: string, path: string): boolean {
  const segments = path.split(/[/?#]/).filter((s) => s !== '');
  if (segments.some((s) => /^[A-Za-z0-9+_-]{6,}={1,2}$/.test(s))) return true;
  const first = segments[0];
  return (
    LOOPBACK.test(host) &&
    first !== undefined &&
    /^[A-Za-z0-9+_-]{8,}$/.test(first) &&
    isSecretLike(first)
  );
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
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replace: marker(TOKEN),
  },
  {
    re: /[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,24}\b/g,
    replace: marker(EMAIL),
  },
  {
    // Digits and letters both: a hash or key, not a run of 'a's or a long number.
    re: /\b[0-9a-fA-F]{32,}\b/g,
    replace: (match) => (/\d/.test(match) && /[a-f]/i.test(match) ? SECRET : match),
  },
  {
    re: /[A-Za-z0-9+/_-]{32,}={0,2}/g,
    replace: (match) => (isSecretLike(match) ? SECRET : match),
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
    out = out.replace(re, (match: string, ...args: unknown[]) =>
      replace(match, args.slice(0, -2) as (string | undefined)[]),
    );
  }
  return out;
}
