import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventBus } from '@project-deck/core';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { attachWebSocket } from './ws.js';

const TOKEN = 'ws-test-token-0123456789abcdef0123456789abcdef';
const closers: (() => unknown)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function serve(): Promise<number> {
  const server: Server = createServer();
  let port = 0;
  const ws = attachWebSocket({
    server,
    bus: new EventBus(),
    token: TOKEN,
    sessionSecret: 'secret-0123456789abcdef0123456789abcdef0123',
    port: () => port,
    hello: () => ({}),
    heartbeat: { intervalMs: 50, pongTimeoutMs: 50 },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  closers.push(() => {
    ws.close();
    return new Promise((r) => server.close(r));
  });
  return port;
}

function connect(port: number, autoPong: boolean): WebSocket {
  const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { 'x-deck-token': TOKEN },
    autoPong,
  });
  client.on('error', () => undefined);
  closers.push(() => client.terminate());
  return client;
}

describe('WebSocket heartbeat', () => {
  it('sends heartbeat messages to a quiet client and keeps it while it answers pings', async () => {
    const port = await serve();
    const client = connect(port, true);
    const types: string[] = [];
    client.on('message', (data) => {
      types.push((JSON.parse((data as Buffer).toString('utf8')) as { type: string }).type);
    });
    let closed = false;
    client.on('close', () => (closed = true));
    await new Promise((r) => setTimeout(r, 400));
    expect(types[0]).toBe('hello');
    expect(types.filter((t) => t === 'heartbeat').length).toBeGreaterThanOrEqual(3);
    expect(closed).toBe(false);
  });

  it('drops a client that never answers a ping', async () => {
    const port = await serve();
    const client = connect(port, false);
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    await expect(closed).resolves.toBeUndefined();
  });
});
