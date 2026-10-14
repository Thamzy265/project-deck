import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionGuard } from '../state/storage.js';
import type { ConnectionState, SocketLike, StatusCheck } from './connection.js';
import { Connection, IDLE_TIMEOUT_MS, backoffDelay } from './connection.js';

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.();
  }
  message(data: unknown): void {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }
  drop(): void {
    this.onerror?.();
    this.onclose?.();
  }
}

function memoryGuard(): SessionGuard & { flag: boolean; clears: number } {
  const g = {
    flag: false,
    clears: 0,
    tryReload() {
      if (g.flag) return false;
      g.flag = true;
      return true;
    },
    clear() {
      g.flag = false;
      g.clears++;
    },
  };
  return g;
}

function setup(statuses: StatusCheck[] = []) {
  const sockets: FakeSocket[] = [];
  const states: ConnectionState[] = [];
  const opens: boolean[] = [];
  const messages: unknown[] = [];
  const guard = memoryGuard();
  const reloadPage = vi.fn();
  const checkStatus = vi.fn(() => Promise.resolve(statuses.shift() ?? 'unreachable'));
  const conn = new Connection({
    openSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    checkStatus,
    guard,
    reloadPage,
    random: () => 0.5,
    onState: (s) => states.push(s),
    onOpen: (reconnect) => opens.push(reconnect),
    onMessage: (m) => messages.push(m),
  });
  const last = (): FakeSocket => {
    const s = sockets.at(-1);
    if (s === undefined) throw new Error('no socket');
    return s;
  };
  return { conn, sockets, states, opens, messages, guard, reloadPage, checkStatus, last };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('backoffDelay', () => {
  it('waits 0.5, 1, 2, then at most 5 s, with jitter below the base', () => {
    expect([1, 2, 3, 4, 9].map((n) => backoffDelay(n, () => 1))).toEqual([
      500, 1000, 2000, 5000, 5000,
    ]);
    expect(backoffDelay(1, () => 0)).toBe(250);
  });
});

describe('Connection', () => {
  it('connects, clears the reload flag and passes valid messages on', () => {
    const t = setup();
    t.guard.flag = true;
    t.conn.start();
    expect(t.states.at(-1)).toEqual({ kind: 'connecting' });
    t.last().open();
    expect(t.states.at(-1)).toEqual({ kind: 'connected' });
    expect(t.guard.flag).toBe(false);
    expect(t.opens).toEqual([false]);
    t.last().message({ type: 'heartbeat' });
    t.last().message({ type: 'task.current', payload: {} });
    t.last().message('not json');
    expect(t.messages).toEqual([{ type: 'heartbeat' }]);
  });

  it('retries with backoff while the daemon is unreachable, then reconnects', async () => {
    const t = setup(['unreachable', 'unreachable']);
    t.conn.start();
    t.last().open();
    t.last().drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.states.at(-1)).toEqual({ kind: 'retrying', attempt: 1 });
    expect(t.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(375);
    expect(t.sockets).toHaveLength(2);
    t.last().drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.states.at(-1)).toEqual({ kind: 'retrying', attempt: 2 });
    await vi.advanceTimersByTimeAsync(750);
    expect(t.sockets).toHaveLength(3);
    t.last().open();
    expect(t.states.at(-1)).toEqual({ kind: 'connected' });
    expect(t.opens).toEqual([false, true]);
    expect(t.reloadPage).not.toHaveBeenCalled();
  });

  it('reloads the page once when the cookie is refused (daemon restarted)', async () => {
    const t = setup(['unauthorized']);
    t.conn.start();
    t.last().open();
    t.last().drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.reloadPage).toHaveBeenCalledTimes(1);
    expect(t.states.at(-1)).toEqual({ kind: 'reauth' });
    expect(t.guard.flag).toBe(true);
  });

  it('shows "Login refused" when the reload did not help', async () => {
    const t = setup(['unauthorized']);
    t.guard.flag = true;
    t.conn.start();
    t.last().drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.reloadPage).not.toHaveBeenCalled();
    expect(t.states.at(-1)).toEqual({ kind: 'login-refused' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.sockets).toHaveLength(1);
  });

  it('recovers from a second daemon restart in the same tab', async () => {
    const t = setup(['unauthorized']);
    // First restart: reloaded, and the new page connected.
    t.guard.tryReload();
    t.conn.start();
    t.last().open();
    expect(t.guard.flag).toBe(false);
    // Second restart.
    t.last().drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.reloadPage).toHaveBeenCalledTimes(1);
  });

  it('clears the flag when the status check succeeds after a failed socket', async () => {
    const t = setup(['ok']);
    t.guard.flag = true;
    t.conn.start();
    t.last().drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.guard.flag).toBe(false);
    expect(t.states.at(-1)).toEqual({ kind: 'retrying', attempt: 1 });
  });

  it('keeps the connection while messages (or heartbeats) keep arriving', async () => {
    const t = setup();
    t.conn.start();
    t.last().open();
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
      t.last().message({ type: 'heartbeat' });
    }
    expect(t.sockets).toHaveLength(1);
    expect(t.last().closed).toBe(false);
    expect(t.checkStatus).not.toHaveBeenCalled();
  });

  it('reconnects when nothing arrives for 30 s', async () => {
    const t = setup(['ok']);
    t.conn.start();
    t.last().open();
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    expect(t.sockets[0]?.closed).toBe(true);
    expect(t.checkStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(t.sockets).toHaveLength(2);
  });

  it('ignores events from a socket it has given up on', async () => {
    const t = setup(['ok']);
    t.conn.start();
    const first = t.last();
    first.open();
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    first.message({ type: 'heartbeat' });
    first.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.messages).toEqual([]);
    expect(t.checkStatus).toHaveBeenCalledTimes(1);
  });

  it('stops for good', async () => {
    const t = setup(['unreachable']);
    t.conn.start();
    t.last().open();
    t.conn.stop();
    expect(t.last().closed).toBe(true);
    t.last().drop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.sockets).toHaveLength(1);
    expect(t.checkStatus).not.toHaveBeenCalled();
  });
});
