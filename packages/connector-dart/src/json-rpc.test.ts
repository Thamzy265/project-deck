import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { ConnectionClosedError, JsonRpcClient, JsonRpcError, isLoopbackWsUri } from './json-rpc.js';
import { FakeRpcServer, RpcFault } from './testing/fake-rpc-server.js';

let server: FakeRpcServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('isLoopbackWsUri', () => {
  it('accepts only ws(s) on loopback', () => {
    expect(isLoopbackWsUri('ws://127.0.0.1:1234/abc')).toBe(true);
    expect(isLoopbackWsUri('ws://localhost:1234/abc')).toBe(true);
    expect(isLoopbackWsUri('ws://[::1]:1234/abc')).toBe(true);
    expect(isLoopbackWsUri('ws://192.168.1.5:1234/abc')).toBe(false);
    expect(isLoopbackWsUri('ws://127.0.0.1.evil.example/abc')).toBe(false);
    expect(isLoopbackWsUri('http://127.0.0.1:1234/abc')).toBe(false);
    expect(isLoopbackWsUri('not a uri')).toBe(false);
  });
});

describe('JsonRpcClient', () => {
  it('refuses non-loopback addresses without connecting', async () => {
    await expect(JsonRpcClient.connect('ws://10.0.0.1:9/x')).rejects.toThrow(/non-loopback/);
  });

  it('returns results and omits params when none are given', async () => {
    server = (await FakeRpcServer.start()).handle('ping', () => 'pong').handle('echo', (p) => p);
    const rpc = await JsonRpcClient.connect(server.uri);
    expect(await rpc.call('ping')).toBe('pong');
    expect(await rpc.call('echo', { a: 1 })).toEqual({ a: 1 });
    expect(server.calls.map((c) => c.hadParams)).toEqual([false, true]);
    rpc.close();
  });

  it('surfaces JSON-RPC errors with their code, even with an empty message', async () => {
    // What the Flutter tool's failed reloadSources looks like on the wire.
    server = (await FakeRpcServer.start()).handle('boom', () => {
      throw new RpcFault(-32603, '');
    });
    const rpc = await JsonRpcClient.connect(server.uri);
    const err: unknown = await rpc.call('boom').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JsonRpcError);
    expect(err).toMatchObject({ code: -32603, message: '' });
    rpc.close();
  });

  it('delivers notifications and rejects pending calls when the peer goes away', async () => {
    server = (await FakeRpcServer.start()).handle('hang', () => new Promise(() => undefined));
    const rpc = await JsonRpcClient.connect(server.uri);
    const notified = vi.fn();
    rpc.onNotification('streamNotify', notified);
    const closed = vi.fn();
    rpc.onClose(closed);
    const pending = rpc.call('hang');
    await vi.waitFor(() => expect(server?.calls.length).toBe(1));
    server.notify({ streamId: 'X' });
    await vi.waitFor(() => expect(notified).toHaveBeenCalledWith({ streamId: 'X' }));
    server.disconnectAll();
    await expect(pending).rejects.toBeInstanceOf(ConnectionClosedError);
    expect(closed).toHaveBeenCalledOnce();
    await expect(rpc.call('ping')).rejects.toBeInstanceOf(ConnectionClosedError);
  });

  it('keeps delivering when a notification or close listener throws', async () => {
    server = await FakeRpcServer.start();
    const onListenerError = vi.fn();
    const rpc = await JsonRpcClient.connect(server.uri, { onListenerError });
    const boom = new Error('listener bug');
    rpc.onNotification('streamNotify', () => {
      throw boom;
    });
    const notified = vi.fn();
    rpc.onNotification('streamNotify', notified);
    rpc.onClose(() => {
      throw boom;
    });
    const closed = vi.fn();
    rpc.onClose(closed);
    server.notify({ streamId: 'X' });
    await vi.waitFor(() => expect(notified).toHaveBeenCalledWith({ streamId: 'X' }));
    expect(() => rpc.close()).not.toThrow();
    expect(closed).toHaveBeenCalledOnce();
    expect(onListenerError).toHaveBeenCalledTimes(2);
    expect(onListenerError).toHaveBeenCalledWith(boom);
  });

  it('rejects a call at once while the socket is closing', async () => {
    server = (await FakeRpcServer.start()).handle('ping', () => 'pong');
    const rpc = await JsonRpcClient.connect(server.uri, { timeoutMs: 60_000 });
    // Close the raw socket so it sits in CLOSING without the client having noticed yet.
    const ws = (rpc as unknown as { ws: WebSocket }).ws;
    const order: string[] = [];
    ws.once('close', () => order.push('close'));
    ws.close();
    const err: unknown = await rpc.call('ping').catch((e: unknown) => {
      order.push('rejected');
      return e;
    });
    expect(err).toBeInstanceOf(ConnectionClosedError);
    expect(order[0]).toBe('rejected');
  });

  it('times out calls that never answer', async () => {
    server = (await FakeRpcServer.start()).handle('hang', () => new Promise(() => undefined));
    const rpc = await JsonRpcClient.connect(server.uri, { timeoutMs: 50 });
    await expect(rpc.call('hang')).rejects.toThrow(/timed out/);
    rpc.close();
  });

  it('takes a shorter timeout for one call', async () => {
    server = (await FakeRpcServer.start()).handle('hang', () => new Promise(() => undefined));
    const rpc = await JsonRpcClient.connect(server.uri, { timeoutMs: 60_000 });
    const started = Date.now();
    await expect(rpc.call('hang', {}, { timeoutMs: 30 })).rejects.toMatchObject({
      timeoutMs: 30,
    });
    expect(Date.now() - started).toBeLessThan(5000);
    rpc.close();
  });

  it('fails to connect when the handshake is rejected', async () => {
    server = await FakeRpcServer.start('/right-code');
    await expect(JsonRpcClient.connect(server.uri.replace('right', 'wrong'))).rejects.toThrow(
      /HTTP 400/,
    );
  });
});
