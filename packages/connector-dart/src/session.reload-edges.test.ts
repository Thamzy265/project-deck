/**
 * Tester's edge cases for reloads made by others (IsolateReload on the Isolate stream).
 * Event shapes come from the spec-built `isolateReloadEvent` fixture (service.md and
 * service_event.cc, checked 14 Oct 2026), changed one field at a time.
 */
import type { ReloadResult, RunningApp } from '@project-deck/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DartAppSession } from './session.js';
import { FakeRpcServer, RpcFault } from './testing/fake-rpc-server.js';
import { asFlutterVmService, isolateReloadEvent, vmResponse } from './testing/fixtures.js';

const app: RunningApp = { id: 'dart-x', name: 'shop', framework: 'flutter', startedBy: 'ide' };
let server: FakeRpcServer | undefined;
let session: DartAppSession | undefined;

afterEach(async () => {
  await session?.detach();
  await server?.close();
  session = undefined;
  server = undefined;
});

const EXTERNAL_OK: ReloadResult = { ok: true, kind: 'hot-reload', source: 'external' };

async function attach(opts: { graceMs?: number; vm?: () => unknown } = {}) {
  const srv = await FakeRpcServer.start('/AbC=/ws');
  server = srv;
  asFlutterVmService(srv);
  if (opts.vm !== undefined) srv.handle('getVM', opts.vm);
  const s = await DartAppSession.attach(srv.uri, app, {
    serviceWaitMs: 100,
    ...(opts.graceMs === undefined ? {} : { ownReloadGraceMs: opts.graceMs }),
  });
  session = s;
  const results: ReloadResult[] = [];
  s.on('reloaded', (r) => results.push(r));
  return { server: srv, session: s, results };
}

/** The fixture's event with its `event` fields replaced or removed. */
function reloadEventWith(fields: Record<string, unknown>, remove: string[] = []) {
  const base = isolateReloadEvent();
  const event = Object.fromEntries(
    Object.entries({ ...base.event, ...fields }).filter(([key]) => !remove.includes(key)),
  );
  return { ...base, event };
}

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

describe('IsolateReload from others: odd event shapes', () => {
  it('ignores an event with no status, and still reports the next good one', async () => {
    const { server, results } = await attach({ graceMs: 0 });
    server.notify(reloadEventWith({}, ['status']));
    server.notify(isolateReloadEvent());
    await vi.waitFor(() => expect(results).toHaveLength(1));
    await settle();
    expect(results).toEqual([EXTERNAL_OK]);
  });

  it.each([
    ['a number status', { status: 1 }],
    ['a null status', { status: null }],
    ['an isolateGroup string', { isolateGroup: 'isolateGroups/1', status: 7 }],
    ['a numeric failure reason', { status: 'failure', reloadFailureReason: 42 }],
  ])('survives %s without crashing the session', async (_name, fields) => {
    const { server, results } = await attach({ graceMs: 0 });
    server.notify(reloadEventWith(fields));
    server.notify(isolateReloadEvent());
    await vi.waitFor(() => expect(results.at(-1)).toEqual(EXTERNAL_OK));
  });

  it('reports a failure with no reason as such', async () => {
    const { server, results } = await attach({ graceMs: 0 });
    server.notify(reloadEventWith({ status: 'failure' }, ['reloadFailureReason']));
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]).toEqual({
      ok: false,
      reason: 'compile-error',
      message: 'Hot reload failed: no reason given',
      source: 'external',
    });
  });

  it('keeps a failure reason of exactly the limit whole', async () => {
    const { server, results } = await attach({ graceMs: 0 });
    const prefix = 'Hot reload failed: ';
    const reason = 'r'.repeat(2000 - prefix.length);
    server.notify(isolateReloadEvent({ failureReason: reason }));
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]).toMatchObject({ message: `${prefix}${reason}` });
  });

  // Regression lock: an event that names no group can't be told apart, so it counts as
  // the main isolate's; dropping it would hide Claude's reloads on an odd VM.
  it('reports an event with no isolateGroup', async () => {
    const { server, results } = await attach({ graceMs: 0 });
    server.notify(reloadEventWith({}, ['isolateGroup']));
    await vi.waitFor(() => expect(results).toEqual([EXTERNAL_OK]));
  });

  it('reports every group when getVM gives no isolateGroupId (older VM)', async () => {
    const vm = vmResponse();
    const isolates = vm.isolates.map((isolate) =>
      Object.fromEntries(Object.entries(isolate).filter(([key]) => key !== 'isolateGroupId')),
    );
    const { server, results } = await attach({ graceMs: 0, vm: () => ({ ...vm, isolates }) });
    server.notify(isolateReloadEvent({ isolateGroupId: 'isolateGroups/77' }));
    await vi.waitFor(() => expect(results).toEqual([EXTERNAL_OK]));
  });

  it('ignores IsolateReload on another stream', async () => {
    const { server, results } = await attach({ graceMs: 0 });
    server.notify({ ...isolateReloadEvent(), streamId: 'Debug' });
    await settle();
    expect(results).toEqual([]);
  });
});

describe('IsolateReload from others: timing', () => {
  it('reports every event in a burst, in order', async () => {
    const { server, results } = await attach({ graceMs: 0 });
    server.notify(isolateReloadEvent());
    server.notify(isolateReloadEvent({ failureReason: 'e1' }));
    server.notify(isolateReloadEvent());
    server.notify(isolateReloadEvent({ failureReason: 'e2' }));
    server.notify(isolateReloadEvent());
    await vi.waitFor(() => expect(results).toHaveLength(5));
    expect(results.map((r) => r.ok)).toEqual([true, false, true, false, true]);
    expect(results.every((r) => r.source === 'external')).toBe(true);
  });

  it('drops the event of its own failed reload and reports the failure once', async () => {
    const { server, session, results } = await attach({ graceMs: 1000 });
    server.handle('s0.reloadSources', () => {
      server.notify(isolateReloadEvent({ failureReason: "Expected ';'" }));
      throw new RpcFault(-32603, '');
    });
    const result = await session.reload();
    await settle();
    expect(result.ok).toBe(false);
    expect(results).toEqual([result]);
  });

  it('drops events from others while its own reload is still running', async () => {
    const { server, session, results } = await attach({ graceMs: 0 });
    let answer: () => void = () => undefined;
    server.handle('s0.reloadSources', async () => {
      server.notify(isolateReloadEvent());
      await new Promise<void>((resolve) => (answer = resolve));
      return { type: 'Success' };
    });
    const reloading = session.reload();
    await settle();
    expect(results).toEqual([]);
    answer();
    await reloading;
    expect(results).toHaveLength(1);
    expect(results[0]?.source).toBeUndefined();
  });

  it('reports a reload by someone else after the grace window', async () => {
    const { server, session, results } = await attach({ graceMs: 50 });
    await session.reload();
    await settle(120);
    server.notify(isolateReloadEvent());
    await vi.waitFor(() => expect(results).toHaveLength(2));
    expect(results[1]).toEqual(EXTERNAL_OK);
  });

  // BUG-T1: the VM posts our own reload's event during the reload. The connector drops it
  // and resets the window, but then the reload's answer re-opens the window, so a reload
  // by Claude or the IDE in the next second is silently dropped from Activity.
  it('reports a reload by someone else right after its own reload whose event already came (BUG-T1)', async () => {
    const { server, session, results } = await attach({ graceMs: 1000 });
    await session.reload();
    server.notify(isolateReloadEvent());
    await vi.waitFor(() => expect(results).toHaveLength(2), { timeout: 500 });
    expect(results[1]).toEqual(EXTERNAL_OK);
  });

  // BUG-T1 (same cause): a hot restart posts no IsolateReload, yet it opens the same
  // window, so the next reload by someone else within a second is dropped.
  it('reports a reload by someone else right after its own hot restart (BUG-T1)', async () => {
    const { server, session, results } = await attach({ graceMs: 1000 });
    await session.restart();
    await settle();
    server.notify(isolateReloadEvent());
    await vi.waitFor(() => expect(results).toHaveLength(2), { timeout: 500 });
    expect(results[1]).toEqual(EXTERNAL_OK);
  });

  // BUG-T2: JsonRpcClient.close() marks the client closed but still delivers messages
  // that arrive while the WebSocket is CLOSING, so a detached session keeps emitting.
  // The AppManager unsubscribes before detaching, so Activity is safe today.
  it('reports nothing after detach (BUG-T2)', async () => {
    const { server, session, results } = await attach({ graceMs: 0 });
    await session.detach();
    server.notify(isolateReloadEvent());
    await settle();
    expect(results).toEqual([]);
  });
});
