import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOKEN_HEADER = 'x-deck-token';

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

const LOCAL_HOSTNAMES = ['127.0.0.1', 'localhost'];

/**
 * Blocks DNS rebinding: a page on evil.example that resolves to 127.0.0.1
 * still sends `Host: evil.example`.
 */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  return LOCAL_HOSTNAMES.some((name) => host === `${name}:${port}`);
}

/** Requests without an Origin (curl, the MCP server, hooks) are allowed; browsers must be same-origin. */
export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true;
  return LOCAL_HOSTNAMES.some((name) => origin === `http://${name}:${port}`);
}

export function tokenFromHeaders(get: (name: string) => string | undefined): string | undefined {
  const direct = get(TOKEN_HEADER);
  if (direct !== undefined) return direct;
  const auth = get('authorization');
  const match = auth === undefined ? null : /^Bearer\s+(\S+)$/i.exec(auth);
  return match?.[1];
}

/** Constant-time comparison that doesn't leak the expected length. */
export function tokensEqual(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export const SESSION_COOKIE_PREFIX = 'deck_session_';

/**
 * Browsers share cookies across ports on one host, so the port is in the name: two
 * daemons (or any other server on 127.0.0.1) can't overwrite each other's cookie.
 */
export function sessionCookieName(port: number): string {
  return `${SESSION_COOKIE_PREFIX}${port}`;
}

export function sessionCookie(port: number, secret: string): string {
  return `${sessionCookieName(port)}=${secret}; HttpOnly; SameSite=Strict; Path=/`;
}

/** Every value sent under `name`; another server on 127.0.0.1 may have set a duplicate. */
export function cookieValues(header: string | undefined, name: string): string[] {
  if (header === undefined) return [];
  const values: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) values.push(part.slice(eq + 1).trim());
  }
  return values;
}

type HeaderGetter = (name: string) => string | undefined;

/**
 * A tab opened on the dashboard, not a script, frame or page elsewhere. Clients that send
 * no fetch metadata at all (older browsers, curl) count too; they are outside the
 * web-page threat this check is for.
 */
export function isTopLevelNavigation(get: HeaderGetter): boolean {
  const site = get('sec-fetch-site');
  const mode = get('sec-fetch-mode');
  if (site === undefined && mode === undefined) return true;
  return (site === 'none' || site === 'same-origin') && mode === 'navigate';
}

export interface Credentials {
  token: string;
  sessionSecret: string;
  port: number;
}

/**
 * The token header (MCP server, CLI, hooks) or the dashboard cookie. Pages on other
 * 127.0.0.1 ports count as same-site, so SameSite=Strict still sends them the cookie;
 * fetch metadata and the exact Origin are what keep them out.
 */
export function authenticate(
  get: HeaderGetter,
  creds: Credentials,
): 'token' | 'cookie' | undefined {
  const token = tokenFromHeaders(get);
  // A wrong token is never ignored, even when a valid cookie comes with it.
  if (token !== undefined) return tokensEqual(token, creds.token) ? 'token' : undefined;
  const values = cookieValues(get('cookie'), sessionCookieName(creds.port));
  if (!values.some((value) => tokensEqual(value, creds.sessionSecret))) return undefined;
  const site = get('sec-fetch-site');
  if (site !== undefined && site !== 'same-origin') return undefined;
  const origin = get('origin');
  if (origin !== undefined && origin !== `http://${get('host') ?? ''}`) return undefined;
  return 'cookie';
}
