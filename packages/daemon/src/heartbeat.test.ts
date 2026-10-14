import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeartbeatSocket } from './heartbeat.js';
import {
  HEARTBEAT_MESSAGE,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  startHeartbeat,
} from './heartbeat.js';

class FakeSocket extends EventEmitter implements HeartbeatSocket {
  readonly sent: string[] = [];
  pings = 0;
  terminated = false;
  /** Answer pings the way a live browser does. */
  autoPong = true;

  ping(): void {
    this.pings++;
    if (this.autoPong) queueMicrotask(() => this.emit('pong'));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  terminate(): void {
    this.terminated = true;
    this.emit('close');
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startHeartbeat', () => {
  it('uses a 15 s interval and a 10 s pong timeout', () => {
    expect(PING_INTERVAL_MS).toBe(15_000);
    expect(PONG_TIMEOUT_MS).toBe(10_000);
    expect(JSON.parse(HEARTBEAT_MESSAGE)).toEqual({ type: 'heartbeat' });
  });

  it('keeps a quiet but live client: a heartbeat message and a ping every 15 s', async () => {
    const socket = new FakeSocket();
    startHeartbeat(socket);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS - 1);
    expect(socket.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.sent).toEqual([HEARTBEAT_MESSAGE]);
    expect(socket.pings).toBe(1);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 4);
    expect(socket.sent).toHaveLength(5);
    expect(socket.pings).toBe(5);
    expect(socket.terminated).toBe(false);
  });

  it('terminates a client that sends no pong within 10 s', async () => {
    const socket = new FakeSocket();
    socket.autoPong = false;
    startHeartbeat(socket);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS + PONG_TIMEOUT_MS - 1);
    expect(socket.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.terminated).toBe(true);
  });

  it('accepts a late pong that still arrives inside the timeout', async () => {
    const socket = new FakeSocket();
    socket.autoPong = false;
    startHeartbeat(socket);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS + PONG_TIMEOUT_MS - 1);
    socket.emit('pong');
    await vi.advanceTimersByTimeAsync(PONG_TIMEOUT_MS);
    expect(socket.terminated).toBe(false);
  });

  it('clears every timer when the socket closes', async () => {
    const socket = new FakeSocket();
    socket.autoPong = false;
    startHeartbeat(socket);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    socket.emit('close');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 3);
    expect(socket.terminated).toBe(false);
    expect(socket.pings).toBe(1);
  });

  it('clears every timer when stopped', () => {
    const socket = new FakeSocket();
    const stop = startHeartbeat(socket);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('terminates instead of throwing when a ping or send fails', async () => {
    const socket = new FakeSocket();
    socket.ping = () => {
      throw new Error('not open');
    };
    startHeartbeat(socket);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    expect(socket.terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
