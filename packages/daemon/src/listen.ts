import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** How many ports after the requested one are tried before letting the OS choose. */
export const PORT_ATTEMPTS = 20;

/**
 * EACCES counts as "try another port" because Windows reserves port ranges (Hyper-V,
 * WSL, Docker) and binding inside one fails with EACCES rather than EADDRINUSE.
 */
const FALLBACK_CODES = new Set(['EADDRINUSE', 'EACCES']);

/**
 * Listens on `port`, or on the next free one when it is taken (other tools, such as
 * Dart DevTools, grab fixed ports too). After `attempts` busy ports it takes an
 * OS-assigned port. Errors other than EADDRINUSE and EACCES are thrown as is. A port
 * that isn't an integer in 0-65535 is rejected up front rather than quietly replaced by
 * an OS port.
 */
export async function listenWithFallback(
  server: Server,
  host: string,
  port: number,
  attempts = PORT_ATTEMPTS,
): Promise<number> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw Object.assign(new RangeError(`Port must be an integer from 0 to 65535, got ${port}`), {
      code: 'ERR_SOCKET_BAD_PORT',
    });
  }
  const candidates: number[] = [];
  if (port !== 0) {
    for (let p = port; p < port + attempts && p <= 65535; p++) candidates.push(p);
  }
  candidates.push(0);
  for (const candidate of candidates) {
    try {
      await listen(server, host, candidate);
      return (server.address() as AddressInfo).port;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === undefined || !FALLBACK_CODES.has(code) || candidate === 0) throw err;
    }
  }
  throw new Error('unreachable');
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}
