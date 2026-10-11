import type { RunningApp } from '@project-deck/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DartAppSessionOptions } from './session.js';
import { DartAppSession } from './session.js';
import { FakeRpcServer, RpcFault } from './testing/fake-rpc-server.js';
import {
  asFlutterVmService,
  isolateEvent,
  loggingEvent,
  success,
  vmResponse,
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

async function attach(opts: { withFlutterTool?: boolean } & DartAppSessionOptions = {}) {
  const { withFlutterTool, ...sessionOpts } = opts;
  server = await FakeRpcServer.start('/AbC=/ws');
  asFlutterVmService(server, withFlutterTool === undefined ? {} : { withFlutterTool });
  session = await DartAppSession.attach(server.uri, app, { serviceWaitMs: 100, ...sessionOpts });
  return { server, session };
}

/** A WriteEvent carrying raw bytes, so a multibyte character can be split across events. */
const rawWrite = (streamId: 'Stdout' | 'Stderr', bytes: Buffer, timestamp: number) => ({
  streamId,
  event: { type: 'Event', kind: 'WriteEvent', timestamp, bytes: bytes.toString('base64') },
});

const serviceUnregistered = (service: string, method: string) => ({
  streamId: 'Service',
  event: { type: 'Event', kind: 'ServiceUnregistered', timestamp: 2, service, method },
});

describe('DartAppSession edge cases', () => {
  it('B2: a multibyte character split across Stdout WriteEvents is decoded intact', async () => {
    const { server, session } = await attach();
    const bytes = Buffer.from('café 🎉\n', 'utf8');
    // Split inside "é" (2 bytes) and inside the emoji (4 bytes).
    const e = bytes.indexOf(0xa9); // second byte of "é"
    const emoji = bytes.indexOf(0xf0) + 2;
    server.notify(rawWrite('Stdout', bytes.subarray(0, e), 1));
    server.notify(rawWrite('Stdout', bytes.subarray(e, emoji), 2));
    server.notify(rawWrite('Stdout', bytes.subarray(emoji), 3));
    await vi.waitFor(async () => expect(await session.logs().query({})).toHaveLength(1));
    expect((await session.logs().query({}))[0]?.message).toBe('café 🎉');
  });

  it('B2: flushes an incomplete trailing character when the session is detached', async () => {
    const { server, session } = await attach();
    server.notify(rawWrite('Stderr', Buffer.from([0x6f, 0x6b, 0xc3]), 1));
    // Notifications arrive in order, so once this one lands the write above has too.
    server.notify(loggingEvent({ message: 'marker', time: 0 }));
    await vi.waitFor(async () => expect(await session.logs().query({})).toHaveLength(1));
    await session.detach();
    expect((await session.logs().query({})).map((l) => l.message)).toEqual(['marker', 'ok\uFFFD']);
  });

  it('keeps multibyte characters intact when each WriteEvent holds whole characters', async () => {
    const { server, session } = await attach();
    server.notify(rawWrite('Stdout', Buffer.from('café ', 'utf8'), 1));
    server.notify(rawWrite('Stdout', Buffer.from('🎉\n', 'utf8'), 2));
    await vi.waitFor(async () =>
      expect((await session.logs().query({})).map((l) => l.message)).toEqual(['café 🎉']),
    );
  });

  it('reports not-attached (and does not hang) when the isolate exits with no replacement', async () => {
    const { server, session } = await attach();
    let getVmCalls = 0;
    server.handle('getVM', () => {
      getVmCalls++;
      return { ...vmResponse(), isolates: [] };
    });
    server.notify(isolateEvent('IsolateExit', 'isolates/1'));
    await vi.waitFor(() => expect(getVmCalls).toBeGreaterThanOrEqual(1));
    expect(await session.reload()).toEqual({
      ok: false,
      reason: 'not-attached',
      message: 'The app has no running isolate',
    });
    expect(server.calls.some((c) => c.method === 's0.reloadSources')).toBe(false);
  });

  it('says unsupported after the Flutter tool unregisters its reload service', async () => {
    const { server, session } = await attach();
    expect(await session.reload()).toMatchObject({ ok: true });
    server.notify(serviceUnregistered('reloadSources', 's0.reloadSources'));
    await vi.waitFor(async () =>
      expect(await session.reload()).toMatchObject({ ok: false, reason: 'unsupported' }),
    );
    // Restart is a separate service and still works.
    expect(await session.restart()).toMatchObject({ ok: true });
  });

  it('picks up a service re-registered while a reload is waiting for it', async () => {
    const { server, session } = await attach({ serviceWaitMs: 2000 });
    server.notify(serviceUnregistered('reloadSources', 's0.reloadSources'));
    await vi.waitFor(() => {
      // Peek at the private map until the unregistration has landed.
      const probe = (session as unknown as { services: Map<string, string> }).services;
      expect(probe.has('reloadSources')).toBe(false);
    });
    server.handle('s1.reloadSources', () => success);
    const pending = session.reload();
    server.notify({
      streamId: 'Service',
      event: {
        type: 'Event',
        kind: 'ServiceRegistered',
        timestamp: 3,
        service: 'reloadSources',
        method: 's1.reloadSources',
      },
    });
    expect(await pending).toMatchObject({ ok: true, kind: 'hot-reload' });
  });

  it('B4: a reload racing an in-flight hot restart re-reads the isolate and succeeds', async () => {
    const { server, session } = await attach();
    // The fake bumps the isolate as soon as it handles s0.hotRestart; the reload sent right
    // after still carries the old isolate id, which the VM service rejects with -32602.
    const [restart, reload] = await Promise.all([session.restart(), session.reload()]);
    expect(restart).toMatchObject({ ok: true });
    expect(reload).toMatchObject({ ok: true, kind: 'hot-reload' });
    const reloads = server.calls.filter((c) => c.method === 's0.reloadSources');
    expect(reloads.map((c) => c.params?.isolateId)).toEqual(['isolates/1', 'isolates/2']);
  });

  it('B4: a reload still rejected as a stale isolate after one retry is not-attached', async () => {
    const { server, session } = await attach();
    server.handle('s0.reloadSources', () => {
      throw new RpcFault(-32602, "Invalid 'isolateId'");
    });
    expect(await session.reload()).toEqual({
      ok: false,
      reason: 'not-attached',
      message: "The app's isolate changed during the reload (probably a hot restart). Try again.",
    });
    expect(server.calls.filter((c) => c.method === 's0.reloadSources')).toHaveLength(2);
  });

  it('B4: transient or unknown codes are not-attached, never unsupported', async () => {
    const { server, session } = await attach();
    for (const code of [-32000, -32603, 100, 113]) {
      server.handle('s0.reloadSources', () => {
        throw new RpcFault(code, 'transient');
      });
      expect(await session.reload()).toEqual({
        ok: false,
        reason: 'not-attached',
        message: `Hot reload could not run: the VM service returned error ${code} (transient). Try again.`,
      });
    }
  });

  it('B4: an error with no code is not reported as a compile error', async () => {
    const { server, session } = await attach();
    // NaN serialises as null, so the peer's error carries no usable code (read as -32603).
    server.handle('s0.reloadSources', () => {
      throw new RpcFault(Number.NaN, 'something odd');
    });
    expect(await session.reload()).toEqual({
      ok: false,
      reason: 'not-attached',
      message:
        'Hot reload could not run: the VM service returned error -32603 (something odd). Try again.',
    });
  });

  it('B7: reload says not-attached, promptly, when the app exits while waiting for the service', async () => {
    const { server, session } = await attach({ withFlutterTool: false, serviceWaitMs: 5000 });
    const started = Date.now();
    const pending = session.reload();
    server.disconnectAll();
    expect(await pending).toEqual({
      ok: false,
      reason: 'not-attached',
      message: 'The app has exited',
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('ignores malformed stream notifications', async () => {
    const { server, session } = await attach();
    server.notify({ streamId: 'Stdout' });
    server.notify({ streamId: 'Stdout', event: { kind: 'WriteEvent', bytes: 42 } });
    server.notify({ streamId: 'Service', event: { kind: 'ServiceRegistered' } });
    server.notify('garbage');
    server.notify({ streamId: 'Unknown', event: { kind: 'Whatever' } });
    expect(await session.reload()).toMatchObject({ ok: true });
    expect(await session.logs().query({})).toEqual([]);
  });
});
