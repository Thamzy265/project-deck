import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventBus } from '@project-deck/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { attachWebSocket } from './ws.js';

const TOKEN = 'ws-test-token-0123456789abcdef0123456789abcdef';
const closers: (() => unknown)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function open(port: number): Promise<WebSocket> {
  const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { 'x-deck-token': TOKEN } });
  client.on('error', () => undefined);
  await new Promise((r) => client.once('open', r));
  return client;
}

describe('WebSocket clients (R9)', () => {
  it('says when the last client has gone, so per-client work such as table watches stops', async () => {
    const server: Server = createServer();
    let port = 0;
    const lastGone = vi.fn();
    const ws = attachWebSocket({
      server,
      bus: new EventBus(),
      token: TOKEN,
      sessionSecret: 'secret-0123456789abcdef0123456789abcdef0123',
      port: () => port,
      hello: () => ({}),
      onLastClientGone: lastGone,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    closers.push(() => {
      ws.close();
      return new Promise((r) => server.close(r));
    });
    const a = await open(port);
    const b = await open(port);
    a.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(lastGone).not.toHaveBeenCalled();
    b.close();
    await vi.waitFor(() => expect(lastGone).toHaveBeenCalledOnce());
  });
});
