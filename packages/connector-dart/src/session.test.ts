import type { RunningApp } from '@project-deck/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DartAppSession } from './session.js';
import { FakeRpcServer, RpcFault } from './testing/fake-rpc-server.js';
import {
  asFlutterVmService,
  isolateEvent,
  isolateReloadEvent,
  loggingEvent,
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

/** The isolate id sent with the most recent reload. */
function lastReloadIsolate(server: FakeRpcServer): unknown {
  return server.calls.filter((c) => c.method === 's0.reloadSources').at(-1)?.params?.isolateId;
}

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

  it('records the process id and the Android platform from getVM', async () => {
    const { session } = await attach();
    expect(session.app).toEqual({
      ...app,
      pid: 4242,
      device: { id: 'unknown', name: 'Android device', platform: 'android' },
    });
  });

  it('records only the process id when the app is not on Android', async () => {
    server = await FakeRpcServer.start('/AbC=/ws');
    asFlutterVmService(server);
    server.handle('getVM', () => ({ ...vmResponse(), operatingSystem: 'macos', pid: 77 }));
    session = await DartAppSession.attach(server.uri, app, { serviceWaitMs: 100 });
    expect(session.app).toEqual({ ...app, pid: 77 });
  });

  it('ignores a process id that is not a positive integer', async () => {
    server = await FakeRpcServer.start('/AbC=/ws');
    asFlutterVmService(server);
    server.handle('getVM', () => ({ ...vmResponse(), operatingSystem: 'linux', pid: -1 }));
    session = await DartAppSession.attach(server.uri, app, { serviceWaitMs: 100 });
    expect(session.app).toEqual(app);
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
    const { server, session } = await attach();
    expect(await session.restart()).toMatchObject({ ok: true, kind: 'hot-restart' });
    await vi.waitFor(async () => {
      expect(await session.reload()).toMatchObject({ ok: true });
      expect(lastReloadIsolate(server)).toBe('isolates/2');
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
    server.notify(isolateEvent('IsolateExit', 'isolates/1'));
    await vi.waitFor(() => expect(getVmCalls).toBe(1));
    // Sent before the getVM answer on the same socket, so the session sees it mid-refresh.
    server.notify(isolateEvent('IsolateStart', 'isolates/2'));
    release();
    await vi.waitFor(async () => {
      expect(await session.reload()).toMatchObject({ ok: true });
      expect(lastReloadIsolate(server)).toBe('isolates/2');
    });
  });

  // flutter_tools throws RPCError('Unable to reload sources', -32603, ''); the first argument
  // is callingMethod and isn't serialised, so the wire carries {"code":-32603,"message":""}.
  it('reports a failed reload (the Flutter tool sends -32603 with an empty message) as compile-error', async () => {
    const { server, session } = await attach();
    server.handle('s0.reloadSources', () => {
      throw new RpcFault(-32603, '');
    });
    expect(await session.reload()).toEqual({
      ok: false,
      reason: 'compile-error',
      message: 'Hot reload failed, probably a compile error. Check the latest error logs.',
    });
  });

  it('reports a failed hot restart (-32603 with an empty message) as compile-error', async () => {
    const { server, session } = await attach();
    server.handle('s0.hotRestart', () => {
      throw new RpcFault(-32603, '');
    });
    expect(await session.restart()).toEqual({
      ok: false,
      reason: 'compile-error',
      message: 'Hot restart failed, probably a compile error. Check the latest error logs.',
    });
  });

  it('only reports compile-error for the Flutter tool failure code', async () => {
    const { server, session } = await attach();
    server.handle('s0.hotRestart', () => {
      throw new RpcFault(-32000, 'Unable to restart');
    });
    expect(await session.restart()).toMatchObject({ ok: false, reason: 'not-attached' });

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
      reason: 'not-attached',
      message:
        "Hot reload could not run: the VM service returned error -32602 (Invalid 'isolateId'). Try again.",
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

describe('DartAppSession: reloads made by others', () => {
  async function attachWithGrace(graceMs: number) {
    server = await FakeRpcServer.start('/AbC=/ws');
    asFlutterVmService(server);
    session = await DartAppSession.attach(server.uri, app, {
      serviceWaitMs: 100,
      ownReloadGraceMs: graceMs,
    });
    const reloaded = vi.fn();
    session.on('reloaded', reloaded);
    return { server, session, reloaded };
  }

  it('reports a successful IsolateReload it did not start as an external hot reload', async () => {
    const { server, reloaded } = await attachWithGrace(0);
    server.notify(isolateReloadEvent());
    await vi.waitFor(() => expect(reloaded).toHaveBeenCalledOnce());
    expect(reloaded).toHaveBeenCalledWith({ ok: true, kind: 'hot-reload', source: 'external' });
  });

  it('reports a failed one with the VM failure reason', async () => {
    const { server, reloaded } = await attachWithGrace(0);
    server.notify(isolateReloadEvent({ failureReason: "lib/main.dart:3:7: Error: Expected ';'" }));
    await vi.waitFor(() => expect(reloaded).toHaveBeenCalledOnce());
    expect(reloaded).toHaveBeenCalledWith({
      ok: false,
      reason: 'compile-error',
      message: "Hot reload failed: lib/main.dart:3:7: Error: Expected ';'",
      source: 'external',
    });
  });

  it('cuts a very long failure reason', async () => {
    const { server, reloaded } = await attachWithGrace(0);
    server.notify(isolateReloadEvent({ failureReason: 'x'.repeat(10_000) }));
    await vi.waitFor(() => expect(reloaded).toHaveBeenCalledOnce());
    const result = reloaded.mock.calls[0]?.[0] as { message: string };
    expect(result.message.length).toBeLessThanOrEqual(2000);
    expect(result.message.endsWith('…')).toBe(true);
  });

  it('does not report its own reload twice', async () => {
    const { session, reloaded } = await attachWithGrace(1000);
    const result = await session.reload();
    await new Promise((r) => setTimeout(r, 50));
    expect(reloaded).toHaveBeenCalledOnce();
    expect(reloaded).toHaveBeenCalledWith(result);
    expect(result).not.toHaveProperty('source');
  });

  it('ignores the event of its own reload when it arrives just after the answer', async () => {
    const { server, session, reloaded } = await attachWithGrace(1000);
    server.handle('s0.reloadSources', () => {
      setTimeout(() => server.notify(isolateReloadEvent()), 20);
      return { type: 'Success' };
    });
    await session.reload();
    await new Promise((r) => setTimeout(r, 80));
    expect(reloaded).toHaveBeenCalledOnce();
  });

  it('reports a later reload by someone else after its own one', async () => {
    const { server, session, reloaded } = await attachWithGrace(30);
    await session.reload();
    await new Promise((r) => setTimeout(r, 60));
    server.notify(isolateReloadEvent());
    await vi.waitFor(() => expect(reloaded).toHaveBeenCalledTimes(2));
    expect(reloaded).toHaveBeenLastCalledWith({ ok: true, kind: 'hot-reload', source: 'external' });
  });

  it('ignores reloads of another isolate group, such as a spawned background isolate', async () => {
    const { server, reloaded } = await attachWithGrace(0);
    server.notify(isolateReloadEvent({ isolateGroupId: 'isolateGroups/77' }));
    server.notify(isolateReloadEvent());
    await vi.waitFor(() => expect(reloaded).toHaveBeenCalledOnce());
    await new Promise((r) => setTimeout(r, 30));
    expect(reloaded).toHaveBeenCalledOnce();
  });

  it('ignores an IsolateReload with an unknown status', async () => {
    const { server, reloaded } = await attachWithGrace(0);
    const odd = isolateReloadEvent();
    server.notify({ ...odd, event: { ...odd.event, status: 'maybe' } });
    server.notify(isolateReloadEvent());
    await vi.waitFor(() => expect(reloaded).toHaveBeenCalledOnce());
    expect(reloaded).toHaveBeenCalledWith({ ok: true, kind: 'hot-reload', source: 'external' });
  });
});
