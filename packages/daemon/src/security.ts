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
