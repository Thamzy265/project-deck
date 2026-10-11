import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('surfaces JSON-RPC errors with their code', async () => {
    server = (await FakeRpcServer.start()).handle('boom', () => {
      throw new RpcFault(-32603, 'Unable to reload sources');
    });
    const rpc = await JsonRpcClient.connect(server.uri);
    const err: unknown = await rpc.call('boom').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JsonRpcError);
    expect(err).toMatchObject({ code: -32603, message: 'Unable to reload sources' });
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

  it('times out calls that never answer', async () => {
    server = (await FakeRpcServer.start()).handle('hang', () => new Promise(() => undefined));
    const rpc = await JsonRpcClient.connect(server.uri, { timeoutMs: 50 });
    await expect(rpc.call('hang')).rejects.toThrow(/timed out/);
    rpc.close();
  });

  it('fails to connect when the handshake is rejected', async () => {
    server = await FakeRpcServer.start('/right-code');
    await expect(JsonRpcClient.connect(server.uri.replace('right', 'wrong'))).rejects.toThrow(
      /HTTP 400/,
    );
  });
});
