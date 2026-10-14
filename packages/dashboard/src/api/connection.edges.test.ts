import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionGuard, StorageLike } from '../state/storage.js';
import { createSessionGuard } from '../state/storage.js';
import type { ConnectionState, SocketLike, StatusCheck } from './connection.js';
import { Connection, IDLE_TIMEOUT_MS } from './connection.js';

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = 0;
  throwOnClose = false;
  close(): void {
    this.closed++;
    if (this.throwOnClose) throw new Error('InvalidStateError');
  }
  open(): void {
    this.onopen?.();
  }
  raw(data: unknown): void {
    this.onmessage?.({ data });
  }
  drop(): void {
    this.onerror?.();
    this.onclose?.();
  }
}

function throwingStorage(): StorageLike {
  const fail = (): never => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  return { getItem: fail, setItem: fail, removeItem: fail };
}

function setup(
  opts: {
    statuses?: StatusCheck[];
    checkStatus?: () => Promise<StatusCheck>;
    guard?: SessionGuard;
  } = {},
) {
  const statuses = opts.statuses ?? [];
  const sockets: FakeSocket[] = [];
  const states: ConnectionState[] = [];
  const opens: boolean[] = [];
  const messages: unknown[] = [];
  const store = new Map<string, string>();
  const guard =
    opts.guard ??
    createSessionGuard(() => ({
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
      removeItem: (k) => void store.delete(k),
    }));
  const reloadPage = vi.fn();
  const checkStatus = vi.fn(
    opts.checkStatus ?? (() => Promise.resolve(statuses.shift() ?? 'unreachable')),
  );
  const conn = new Connection({
    openSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    checkStatus,
    guard,
    reloadPage,
    random: () => 0,
    onState: (s) => states.push(s),
    onOpen: (reconnect) => opens.push(reconnect),
    onMessage: (m) => messages.push(m),
  });
  const last = (): FakeSocket => {
    const s = sockets.at(-1);
    if (s === undefined) throw new Error('no socket');
    return s;
  };
  return { conn, sockets, states, opens, messages, reloadPage, checkStatus, last, store };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Connection: failure paths', () => {
  it('retries when the socket closes before it ever opened, and counts the first open as new', async () => {
    const t = setup();
    t.conn.start();
    t.last().drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.states.at(-1)).toEqual({ kind: 'retrying', attempt: 1 });
    expect(t.opens).toEqual([]);
    // Equal jitter with random() = 0: half of 0.5 s.
    await vi.advanceTimersByTimeAsync(250);
    expect(t.sockets).toHaveLength(2);
    t.last().open();
    expect(t.opens).toEqual([false]);
    expect(t.states.at(-1)).toEqual({ kind: 'connected' });
  });

  it('ignores messages that fail validation, without dropping the connection', () => {
    const t = setup();
    t.conn.start();
    t.last().open();
    const bad: unknown[] = [
      'not json',
      '{"type":"hello"}',
      '{"type":"app.log","payload":{"appId":"a"}}',
      '{"type":"app.log","payload":{"appId":"a","entry":{"ts":"1","level":"info","source":"app","message":"x"}}}',
      '{"type":"task.current","payload":{}}',
      '{"type":"HEARTBEAT"}',
      'null',
      '42',
      '[]',
      '',
      new ArrayBuffer(8),
      undefined,
    ];
    for (const data of bad) t.last().raw(data);
    expect(t.messages).toEqual([]);
    expect(t.sockets).toHaveLength(1);
    expect(t.last().closed).toBe(0);
    t.last().raw('{"type":"heartbeat"}');
    expect(t.messages).toEqual([{ type: 'heartbeat' }]);
  });

  it('does not let a __proto__ key in a message pollute objects', () => {
    const t = setup();
    t.conn.start();
    t.last().open();
    t.last().raw('{"type":"heartbeat","__proto__":{"polluted":true}}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(t.messages).toEqual([{ type: 'heartbeat' }]);
  });

  it('keeps the connection on any message, even one it does not understand', async () => {
    const t = setup();
    t.conn.start();
    t.last().open();
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1);
    t.last().raw('{"type":"task.current","payload":{}}');
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1);
    expect(t.sockets).toHaveLength(1);
    expect(t.checkStatus).not.toHaveBeenCalled();
  });

  it('gives up on a silent socket exactly at 30 s, not a millisecond before', async () => {
    const t = setup({ statuses: ['ok'] });
    t.conn.start();
    t.last().open();
    await vi.advanceTimersByTimeAsync(15_000);
    t.last().raw('{"type":"heartbeat"}');
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1);
    expect(t.checkStatus).not.toHaveBeenCalled();
    expect(t.last().closed).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.sockets[0]?.closed).toBe(1);
    expect(t.checkStatus).toHaveBeenCalledTimes(1);
    expect(t.states.at(-1)).toEqual({ kind: 'retrying', attempt: 1 });
  });

  it('recovers when closing a dead socket throws', async () => {
    const t = setup();
    t.conn.start();
    t.last().throwOnClose = true;
    t.last().open();
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    expect(t.states.at(-1)).toEqual({ kind: 'retrying', attempt: 1 });
    await vi.advanceTimersByTimeAsync(250);
    expect(t.sockets).toHaveLength(2);
  });

  it('treats a status check that throws as unreachable and keeps retrying', async () => {
    const t = setup({ checkStatus: () => Promise.reject(new Error('boom')) });
    t.conn.start();
    t.last().drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.states.at(-1)).toEqual({ kind: 'retrying', attempt: 1 });
    expect(t.reloadPage).not.toHaveBeenCalled();
  });

  it('does nothing after stop() while a status check is in flight', async () => {
    let answer: (s: StatusCheck) => void = () => undefined;
    const t = setup({ checkStatus: () => new Promise((r) => (answer = r)) });
    t.conn.start();
    t.last().drop();
    const before = t.states.length;
    t.conn.stop();
    answer('unauthorized');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.states).toHaveLength(before);
    expect(t.reloadPage).not.toHaveBeenCalled();
    expect(t.sockets).toHaveLength(1);
  });

  it('a 401 twice in a row in one page reloads once, then says "Login refused"', async () => {
    const t = setup({ statuses: ['unauthorized', 'unauthorized'] });
    t.conn.start();
    t.last().drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.reloadPage).toHaveBeenCalledTimes(1);
    expect(t.states.at(-1)).toEqual({ kind: 'reauth' });

    // The page did not reload (the reload was refused or is slow) and a new page starts.
    const again = setup({ statuses: ['unauthorized'] });
    for (const [k, v] of t.store) again.store.set(k, v);
    again.conn.start();
    again.last().drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(again.reloadPage).not.toHaveBeenCalled();
    expect(again.states.at(-1)).toEqual({ kind: 'login-refused' });
  });

  it('with sessionStorage throwing, a 401 shows "Login refused" without a reload loop', async () => {
    const guard = createSessionGuard(() => throwingStorage());
    const t = setup({ statuses: ['unauthorized'], guard });
    t.conn.start();
    t.last().open();
    t.last().drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.reloadPage).not.toHaveBeenCalled();
    expect(t.states.at(-1)).toEqual({ kind: 'login-refused' });
  });

  it('with sessionStorage full, a 401 shows "Login refused" without a reload loop', async () => {
    const guard = createSessionGuard(
      () =>
        ({
          getItem: () => null,
          setItem: () => {
            throw new DOMException('Quota exceeded', 'QuotaExceededError');
          },
          removeItem: () => undefined,
        }) satisfies StorageLike,
    );
    const t = setup({ statuses: ['unauthorized', 'unauthorized'], guard });
    t.conn.start();
    t.last().drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.reloadPage).not.toHaveBeenCalled();
    expect(t.states.at(-1)).toEqual({ kind: 'login-refused' });
  });

  it('a socket that opens after stop() is ignored', () => {
    const t = setup();
    t.conn.start();
    const s = t.last();
    t.conn.stop();
    s.open();
    s.raw('{"type":"heartbeat"}');
    expect(t.opens).toEqual([]);
    expect(t.messages).toEqual([]);
    expect(s.closed).toBe(1);
  });
});
