import type { RunningApp } from '@project-deck/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DartAppSession } from './session.js';
import { FakeRpcServer, RpcFault } from './testing/fake-rpc-server.js';
import {
  asFlutterVmService,
  isolateEvent,
  loggingEvent,
  success,
  vmResponse,
  writeEvent,
} from './testing/fixtures.js';

const app: RunningApp = { id: 'dart-x', name: 'shop', framework: 'flutter', startedBy: 'ide' };
let server: FakeRpcServer | undefined;
let session: DartAppSession | undefined;

afterEach(async () => {
  await session?.detach();
  await server?.close();
  session = undefined;
  server = undefined;
});

async function attach(opts: { withFlutterTool?: boolean } = {}) {
  server = await FakeRpcServer.start('/AbC=/ws');
  asFlutterVmService(server, opts);
  session = await DartAppSession.attach(server.uri, app, { serviceWaitMs: 100 });
  return { server, session };
}

describe('DartAppSession', () => {
  it('subscribes to the streams it needs', async () => {
    const { server } = await attach();
    const streams = server.calls
      .filter((c) => c.method === 'streamListen')
      .map((c) => c.params?.streamId);
    expect(streams.sort()).toEqual(['Isolate', 'Logging', 'Service', 'Stderr', 'Stdout']);
  });

  it('hot reloads through the Flutter tool service with the main isolate', async () => {
    const { server, session } = await attach();
    const reloaded = vi.fn();
    session.on('reloaded', reloaded);
    const result = await session.reload();
    expect(result).toMatchObject({ ok: true, kind: 'hot-reload' });
    expect(server.calls.find((c) => c.method === 's0.reloadSources')?.params).toEqual({
      isolateId: 'isolates/1',
    });
    expect(reloaded).toHaveBeenCalledWith(result);
  });

  it('follows the new isolate after a hot restart', async () => {
    const { session } = await attach();
    expect(await session.restart()).toMatchObject({ ok: true, kind: 'hot-restart' });
    // The fake rejects a stale isolate id, so this only passes if the session refreshed it.
    await vi.waitFor(async () => {
      expect(await session.reload()).toMatchObject({ ok: true });
    });
  });

  it('re-reads the isolate when IsolateStart arrives during an in-flight refresh', async () => {
    const { server, session } = await attach();
    let release: () => void = () => undefined;
    let getVmCalls = 0;
    server.handle('getVM', () => {
      getVmCalls++;
      // The refresh started by IsolateExit is answered late, and still with the old isolate.
      if (getVmCalls === 1)
        return new Promise((resolve) => {
          release = () => resolve(vmResponse('isolates/1'));
        });
      return vmResponse('isolates/2');
    });
    server.handle('s0.reloadSources', (params) => {
      if (params?.isolateId !== 'isolates/2') throw new RpcFault(-32602, 'stale isolate');
      return success;
    });
    server.notify(isolateEvent('IsolateExit', 'isolates/1'));
    await vi.waitFor(() => expect(getVmCalls).toBe(1));
    // Sent before the getVM answer on the same socket, so the session sees it mid-refresh.
    server.notify(isolateEvent('IsolateStart', 'isolates/2'));
    release();
    await vi.waitFor(async () => {
      expect(await session.reload()).toMatchObject({ ok: true });
    });
  });

  it('reports a failed reload without throwing', async () => {
    const { server, session } = await attach();
    server.handle('s0.reloadSources', () => {
      throw new RpcFault(-32603, 'Unable to reload sources');
    });
    expect(await session.reload()).toEqual({
      ok: false,
      reason: 'compile-error',
      message: 'Hot reload failed: Unable to reload sources. Check the latest error logs.',
    });
  });

  it('only reports compile-error for the Flutter tool failure', async () => {
    const { server, session } = await attach();
    server.handle('s0.hotRestart', () => {
      throw new RpcFault(-32000, 'Unable to restart');
    });
    expect(await session.restart()).toMatchObject({ ok: false, reason: 'compile-error' });

    server.handle('s0.reloadSources', () => {
      throw new RpcFault(-32601, 'Method not found');
    });
    expect(await session.reload()).toEqual({
      ok: false,
      reason: 'unsupported',
      message: 'Hot reload is not available on this app: Method not found.',
    });

    server.handle('s0.reloadSources', () => {
      throw new RpcFault(-32602, "Invalid 'isolateId'");
    });
    expect(await session.reload()).toEqual({
      ok: false,
      reason: 'unsupported',
      message:
        "Hot reload could not run: the VM service returned error -32602 (Invalid 'isolateId').",
    });
  });

  it('says unsupported when no Flutter tool service is announced', async () => {
    const { session } = await attach({ withFlutterTool: false });
    expect(await session.reload()).toMatchObject({ ok: false, reason: 'unsupported' });
  });

  it('turns stdout chunks and log records into entries', async () => {
    const { server, session } = await attach();
    server.notify(writeEvent('Stdout', 'flutter: added ', 10));
    server.notify(writeEvent('Stdout', 'item\n', 11));
    server.notify(writeEvent('Stderr', 'oops\n', 12));
    server.notify(loggingEvent({ message: 'saved', level: 800, loggerName: 'db', time: 13 }));
    await vi.waitFor(async () => {
      expect(await session.logs().query({})).toEqual([
        { ts: 10, level: 'info', source: 'app', tag: 'stdout', message: 'flutter: added item' },
        { ts: 12, level: 'error', source: 'app', tag: 'stderr', message: 'oops' },
        { ts: 13, level: 'info', source: 'app', tag: 'db', message: 'saved' },
      ]);
    });
  });

  it('emits exit when the VM service goes away, then reports not-attached', async () => {
    const { server, session } = await attach();
    const exit = vi.fn();
    session.on('exit', exit);
    server.disconnectAll();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
    expect(await session.reload()).toMatchObject({ ok: false, reason: 'not-attached' });
  });

  it('keeps a partial stdout line when detaching', async () => {
    const { server, session } = await attach();
    server.notify(writeEvent('Stdout', 'no newline yet', 20));
    // Long enough to arrive, well short of the 250 ms idle flush.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await session.detach();
    expect((await session.logs().query({})).map((e) => e.message)).toEqual(['no newline yet']);
  });

  it('detach only closes the connection', async () => {
    const { server, session } = await attach();
    const before = server.calls.length;
    await session.detach();
    await vi.waitFor(() => expect(server.clientCount).toBe(0));
    expect(server.calls.length).toBe(before);
  });
});
