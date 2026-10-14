import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventBus } from '@project-deck/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { HeartbeatSocket } from './heartbeat.js';
import {
  HEARTBEAT_MESSAGE,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  startHeartbeat,
} from './heartbeat.js';
import { attachWebSocket } from './ws.js';

/** A socket whose terminate() does not emit 'close', like one already half torn down. */
class QuietSocket extends EventEmitter implements HeartbeatSocket {
  readonly sent: string[] = [];
  pings = 0;
  terminations = 0;
  sendError: Error | undefined;

  ping(): void {
    this.pings++;
  }

  send(data: string): void {
    if (this.sendError !== undefined) throw this.sendError;
    this.sent.push(data);
  }

  terminate(): void {
    this.terminations++;
  }
}

describe('startHeartbeat edge cases (fake timers)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('terminates once and stops pinging a client that never answers', async () => {
    vi.useFakeTimers();
    const socket = new QuietSocket();
    startHeartbeat(socket);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS + PONG_TIMEOUT_MS);
    expect(socket.terminations).toBe(1);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 10);
    expect(socket.terminations).toBe(1);
    expect(socket.pings).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('counts the timeout from the first unanswered ping, not the latest one', async () => {
    vi.useFakeTimers();
    const socket = new QuietSocket();
    // Pings every 5 s, 12 s to answer: later pings must not push the deadline back.
    startHeartbeat(socket, { intervalMs: 5000, pongTimeoutMs: 12_000 });
    await vi.advanceTimersByTimeAsync(5000 + 12_000 - 1);
    expect(socket.pings).toBe(3);
    expect(socket.terminations).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.terminations).toBe(1);
  });

  it('keeps a client that answers every ping late but inside the timeout, for an hour', async () => {
    vi.useFakeTimers();
    const socket = new QuietSocket();
    startHeartbeat(socket);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    for (let i = 0; i < 240; i++) {
      await vi.advanceTimersByTimeAsync(PONG_TIMEOUT_MS - 1);
      socket.emit('pong');
      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS - (PONG_TIMEOUT_MS - 1));
    }
    expect(socket.pings).toBe(241);
    expect(socket.terminations).toBe(0);
    // One interval plus at most one pong timer.
    expect(vi.getTimerCount()).toBeLessThanOrEqual(2);
  });

  it('terminates without pinging when send throws', async () => {
    vi.useFakeTimers();
    const socket = new QuietSocket();
    socket.sendError = new Error('WebSocket is not open: readyState 2 (CLOSING)');
    startHeartbeat(socket);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    expect(socket.pings).toBe(0);
    expect(socket.terminations).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('terminates when send throws a non-Error value', async () => {
    vi.useFakeTimers();
    const socket = new QuietSocket();
    socket.send = () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'closed';
    };
    startHeartbeat(socket);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    expect(socket.terminations).toBe(1);
  });

  it('ignores a pong that arrives with no ping outstanding', async () => {
    vi.useFakeTimers();
    const socket = new QuietSocket();
    startHeartbeat(socket);
    socket.emit('pong');
    socket.emit('pong');
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS + PONG_TIMEOUT_MS);
    expect(socket.terminations).toBe(1);
  });

  it('is safe to stop twice, and after close', async () => {
    vi.useFakeTimers();
    const socket = new QuietSocket();
    const stop = startHeartbeat(socket);
    socket.emit('close');
    stop();
    stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(socket.listenerCount('pong')).toBe(0);
    expect(socket.listenerCount('close')).toBe(0);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 2);
    expect(socket.sent).toEqual([]);
  });

  it('removes its listeners after it terminates a dead client', async () => {
    vi.useFakeTimers();
    const socket = new QuietSocket();
    startHeartbeat(socket);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS + PONG_TIMEOUT_MS);
    expect(socket.listenerCount('pong')).toBe(0);
    expect(socket.listenerCount('close')).toBe(0);
  });

  it('sends exactly the heartbeat message, never anything else', async () => {
    vi.useFakeTimers();
    const socket = new QuietSocket();
    startHeartbeat(socket, { intervalMs: 1000, pongTimeoutMs: 100_000 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(socket.sent).toEqual([HEARTBEAT_MESSAGE, HEARTBEAT_MESSAGE, HEARTBEAT_MESSAGE]);
  });
});

describe('heartbeat over a real local socket', () => {
  const closers: (() => unknown)[] = [];
  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
  });

  const TOKEN = 'hb-edges-token-0123456789abcdef0123456789abcdef';

  async function serve(bus: EventBus): Promise<number> {
    const server: Server = createServer();
    let port = 0;
    const ws = attachWebSocket({
      server,
      bus,
      token: TOKEN,
      sessionSecret: 'hb-edges-secret-0123456789abcdef0123456789ab',
      port: () => port,
      hello: () => ({}),
      heartbeat: { intervalMs: 40, pongTimeoutMs: 40 },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    closers.push(() => {
      ws.close();
      return new Promise((r) => server.close(r));
    });
    return port;
  }

  function client(port: number, autoPong: boolean): WebSocket {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { 'x-deck-token': TOKEN },
      autoPong,
    });
    ws.on('error', () => undefined);
    closers.push(() => ws.terminate());
    return ws;
  }

  it('drops the silent client but keeps the live one, and the bus keeps working', async () => {
    const bus = new EventBus();
    const port = await serve(bus);
    const silent = client(port, false);
    const live = client(port, true);
    const liveTypes: string[] = [];
    live.on('message', (data) => {
      liveTypes.push((JSON.parse((data as Buffer).toString('utf8')) as { type: string }).type);
    });
    await new Promise<void>((resolve) => silent.once('close', () => resolve()));
    expect(live.readyState).toBe(WebSocket.OPEN);
    expect(() => bus.emit('claude.done', {})).not.toThrow();
    await vi.waitFor(() => expect(liveTypes).toContain('claude.done'));
    expect(liveTypes).toContain('heartbeat');
  });

  it('survives a client that closes the TCP socket without a close frame', async () => {
    const bus = new EventBus();
    const port = await serve(bus);
    const first = client(port, true);
    await new Promise<void>((resolve) => first.once('open', () => resolve()));
    first.terminate();
    await new Promise((r) => setTimeout(r, 150));
    const second = client(port, true);
    await new Promise<void>((resolve) => second.once('open', () => resolve()));
    expect(second.readyState).toBe(WebSocket.OPEN);
  });
});
