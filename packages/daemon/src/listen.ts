import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** How many ports after the requested one are tried before letting the OS choose. */
export const PORT_ATTEMPTS = 20;

/**
 * Listens on `port`, or on the next free one when it is taken (other tools, such as
 * Dart DevTools, grab fixed ports too). After `attempts` busy ports it takes an
 * OS-assigned port. Errors other than EADDRINUSE are thrown as is.
 */
export async function listenWithFallback(
  server: Server,
  host: string,
  port: number,
  attempts = PORT_ATTEMPTS,
): Promise<number> {
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
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || candidate === 0) throw err;
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
