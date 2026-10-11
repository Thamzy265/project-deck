import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';
import { ConnectionClosedError, JsonRpcClient, JsonRpcError } from './json-rpc.js';

/** A bare server so tests can send frames no well-behaved JSON-RPC peer would. */
interface RawPeer {
  uri: string;
  /** Resolves to the server side of the next connection. */
  socket: Promise<WebSocket>;
  /** Every text frame the client sent, parsed. */
  received: unknown[];
  close: () => Promise<void>;
}

async function rawPeer(): Promise<RawPeer> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const received: unknown[] = [];
  const socket = new Promise<WebSocket>((resolve) => {
    wss.once('connection', (ws) => {
      ws.on('message', (data) => received.push(JSON.parse((data as Buffer).toString('utf8'))));
      resolve(ws);
    });
  });
  const { port } = wss.address() as AddressInfo;
  return {
    uri: `ws://127.0.0.1:${port}/`,
    socket,
    received,
    close: () =>
      new Promise((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      }),
  };
}

/** Waits until the client has sent `n` frames and returns the last one's id. */
async function idOfFrame(peer: RawPeer, n: number): Promise<unknown> {
  await vi.waitFor(() => expect(peer.received.length).toBeGreaterThanOrEqual(n));
  return (peer.received[n - 1] as { id?: unknown }).id;
}

let peer: RawPeer | undefined;
let rpc: JsonRpcClient | undefined;
afterEach(async () => {
  rpc?.close();
  rpc = undefined;
  await peer?.close();
  peer = undefined;
});

async function connect(timeoutMs = 60_000) {
  peer = await rawPeer();
  rpc = await JsonRpcClient.connect(peer.uri, { timeoutMs });
  return { peer, rpc, ws: await peer.socket };
}

describe('JsonRpcClient edge cases', () => {
  it('rejects at once with ConnectionClosedError when the send callback reports an error', async () => {
    const { rpc } = await connect(60_000);
    // Simulate ws failing the write after the readyState check passed.
    const ws = (rpc as unknown as { ws: { send: (d: string, cb: (e?: Error) => void) => void } })
      .ws;
    ws.send = (_data, cb) => {
      queueMicrotask(() => cb(new Error('EPIPE')));
    };
    const started = Date.now();
    await expect(rpc.call('ping')).rejects.toBeInstanceOf(ConnectionClosedError);
    expect(Date.now() - started).toBeLessThan(1000);
    // The failed id must not linger: a later close rejects nothing twice and does not throw.
    expect((rpc as unknown as { pending: Map<number, unknown> }).pending.size).toBe(0);
  });

  it('ignores a send callback called with null on success', async () => {
    const { peer, rpc, ws } = await connect();
    const call = rpc.call('ping');
    const id = await idOfFrame(peer, 1);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, result: 'pong' }));
    expect(await call).toBe('pong');
  });

  it('ignores responses with unknown ids and duplicate responses', async () => {
    const { peer, rpc, ws } = await connect();
    const first = rpc.call('a');
    const id = await idOfFrame(peer, 1);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 999, result: 'stray' }));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: String(id), result: 'string id' }));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, result: 'one' }));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, result: 'two' }));
    expect(await first).toBe('one');
    // The client keeps working after the duplicate.
    const second = rpc.call('b');
    const id2 = await idOfFrame(peer, 2);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: id2, result: 'b' }));
    expect(await second).toBe('b');
  });

  it('ignores non-object JSON, invalid JSON, arrays and binary garbage', async () => {
    const { peer, rpc, ws } = await connect();
    const call = rpc.call('a');
    const id = await idOfFrame(peer, 1);
    for (const frame of ['42', 'null', '"text"', 'true', '[1,2]', '{not json', '[]'])
      ws.send(frame);
    ws.send(Buffer.from([0xff, 0xfe, 0x00]));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, result: 'ok' }));
    expect(await call).toBe('ok');
  });

  it('maps an error without a code to -32603 and without a message to Unknown error', async () => {
    const { peer, rpc, ws } = await connect();
    const call = rpc.call('a');
    const id = await idOfFrame(peer, 1);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, error: { data: { detail: 'x' } } }));
    const err: unknown = await call.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JsonRpcError);
    expect(err).toMatchObject({ code: -32603, message: 'Unknown error', data: { detail: 'x' } });
  });

  it('B1: a response with "error": null (JSON-RPC 1.0 style) resolves with its result instead of throwing', async () => {
    const { peer, rpc } = await connect();
    const call = rpc.call('a');
    const id = await idOfFrame(peer, 1);
    // Fed straight to the handler: through the socket the TypeError is thrown inside a
    // ws 'message' listener, which would crash the process (and the test runner).
    const onMessage = (rpc as unknown as { onMessage: (data: Buffer) => void }).onMessage.bind(rpc);
    expect(() =>
      onMessage(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result: 'ok', error: null }))),
    ).not.toThrow();
    expect(await call).toBe('ok');
  });

  it('B1: rejects with a JsonRpcError when the error is a bare string', async () => {
    const { peer, rpc, ws } = await connect();
    const call = rpc.call('a');
    const id = await idOfFrame(peer, 1);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, error: 'boom' }));
    const err: unknown = await call.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JsonRpcError);
    expect(err).toMatchObject({ code: -32603, message: 'boom' });
  });

  it('handles a very large response', async () => {
    const { peer, rpc, ws } = await connect();
    const call = rpc.call('big');
    const id = await idOfFrame(peer, 1);
    const big = 'é'.repeat(2_000_000);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, result: big }));
    expect(await call).toBe(big);
  });

  it('answers a request from the peer with -32601 and the same id', async () => {
    const { peer, ws } = await connect();
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'srv-1', method: 'registerService', params: {} }));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'anything' }));
    await vi.waitFor(() => expect(peer.received.length).toBe(2));
    expect(peer.received).toEqual([
      { jsonrpc: '2.0', id: 'srv-1', error: { code: -32601, message: 'Method not found' } },
      { jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'Method not found' } },
    ]);
  });

  it('does not deliver a peer request to notification listeners', async () => {
    const { peer, rpc, ws } = await connect();
    const notified = vi.fn();
    rpc.onNotification('streamNotify', notified);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'streamNotify', params: {} }));
    await vi.waitFor(() => expect(peer.received.length).toBe(1));
    expect(notified).not.toHaveBeenCalled();
  });

  it('ignores a late answer to a call that already timed out', async () => {
    const { peer, rpc, ws } = await connect(100);
    // Answer 'fast' straight away so only 'slow' can time out.
    ws.on('message', (data) => {
      const req = JSON.parse((data as Buffer).toString('utf8')) as { id: number; method: string };
      if (req.method === 'fast') ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: 1 }));
    });
    const call = rpc.call('slow').catch((e: unknown) => e);
    const id = await idOfFrame(peer, 1);
    expect(await call).toMatchObject({ message: expect.stringMatching(/timed out/) as unknown });
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, result: 'late' }));
    expect(await rpc.call('fast')).toBe(1);
    expect(await idOfFrame(peer, 2)).not.toBe(id);
  });

  it('runs onClose immediately-ish when registered after close', async () => {
    const { rpc } = await connect();
    rpc.close();
    const closed = vi.fn();
    rpc.onClose(closed);
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
  });
});
