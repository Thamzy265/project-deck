import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { EventBus } from '@project-deck/core';
import { WebSocket, WebSocketServer } from 'ws';
import { authenticate, isAllowedHost, isAllowedOrigin } from './security.js';

export const WS_PATH = '/ws';
/** Clients never send us anything meaningful, so refuse large frames outright. */
const MAX_INCOMING_BYTES = 4 * 1024;
/** A client this far behind is stalled; drop it rather than buffer without bound. It can reconnect. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export interface WsOptions {
  server: Server;
  bus: EventBus;
  token: string;
  sessionSecret: string;
  port: () => number;
  /** First message to each client, so it doesn't start from an empty state. */
  hello: () => unknown;
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * Broadcasts every bus event as `{ type, payload }`.
 * Browsers can't set headers on a WebSocket, so the dashboard uses its cookie. A token in
 * the query string is never accepted: URLs end up in history and logs.
 */
export function attachWebSocket(opts: WsOptions): { close: () => void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INCOMING_BYTES });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const port = opts.port();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const header = (name: string): string | undefined => {
      const value = req.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    if (url.pathname !== WS_PATH) return reject(socket, 404, 'Not Found');
    if (!isAllowedHost(header('host'), port) || !isAllowedOrigin(header('origin'), port)) {
      return reject(socket, 403, 'Forbidden');
    }
    const creds = { token: opts.token, sessionSecret: opts.sessionSecret, port };
    if (authenticate(header, creds) === undefined) return reject(socket, 401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };

  wss.on('connection', (ws) => {
    // Without a listener, a malformed frame's 'error' event would crash the daemon.
    ws.on('error', () => ws.terminate());
    ws.send(JSON.stringify({ type: 'hello', payload: opts.hello() }));
  });

  const offBus = opts.bus.onAny((type, payload) => {
    const message = JSON.stringify({ type, payload });
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.bufferedAmount > MAX_BUFFERED_BYTES) client.terminate();
      else client.send(message);
    }
  });

  opts.server.on('upgrade', onUpgrade);

  return {
    close: () => {
      offBus();
      opts.server.off('upgrade', onUpgrade);
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
}
