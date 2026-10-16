import type { RunningApp } from '@project-deck/core';
import { AppExtensionError } from '@project-deck/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DartAppSession } from './session.js';
import { FakeRpcServer, RpcFault } from './testing/fake-rpc-server.js';
import {
  asFlutterVmService,
  collectedSentinel,
  extensionEvent,
  isolateEvent,
  isolateResponse,
  serviceExtensionAdded,
  vmResponse,
} from './testing/fixtures.js';

const app: RunningApp = { id: 'dart-x', name: 'shop', framework: 'flutter', startedBy: 'ide' };
const LIST = 'ext.flutterdeck.drift.v1.list';
const QUERY = 'ext.flutterdeck.drift.v1.query';
let server: FakeRpcServer | undefined;
let session: DartAppSession | undefined;

afterEach(async () => {
  await session?.detach();
  await server?.close();
  session = undefined;
  server = undefined;
});

async function attach(extensionRPCs: string[] = [LIST, 'ext.flutter.exit']) {
  server = await FakeRpcServer.start('/AbC=/ws');
  asFlutterVmService(server);
  server.handle('getIsolate', (params) =>
    isolateResponse(String(params?.isolateId), extensionRPCs),
  );
  session = await DartAppSession.attach(server.uri, app, { serviceWaitMs: 100 });
  return { server, session };
}

const until = (check: () => boolean) => vi.waitFor(() => expect(check()).toBe(true));

async function rejection(p: Promise<unknown>): Promise<AppExtensionError> {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(err instanceof AppExtensionError))
    throw new Error(`Expected AppExtensionError: ${String(err)}`);
  return err;
}

describe('DartAppSession extensions', () => {
  it('subscribes to the Extension stream', async () => {
    const { server } = await attach();
    const streams = server.calls.filter((c) => c.method === 'streamListen');
    expect(streams.map((c) => c.params?.streamId)).toContain('Extension');
  });

  it('knows the allowed extensions the app registered before attach', async () => {
    const { session } = await attach();
    expect(session.extensions.has(LIST)).toBe(true);
    expect(session.extensions.has('ext.flutter.exit')).toBe(false);
    expect(session.extensions.has(QUERY)).toBe(false);
  });

  it('learns extensions added later and calls them on the isolate that added them', async () => {
    const { server, session } = await attach([]);
    server.handle(QUERY, (params) => ({ protocol: 1, echo: params }));
    server.notify(serviceExtensionAdded(QUERY, 'isolates/7'));
    await until(() => session.extensions.has(QUERY));
    await expect(session.extensions.call(QUERY, { sql: 'select 1' })).resolves.toEqual({
      protocol: 1,
      echo: { sql: 'select 1', isolateId: 'isolates/7' },
    });
  });

  it('calls on the main isolate when the extension was never announced', async () => {
    const { server, session } = await attach([]);
    server.handle(QUERY, (params) => params?.isolateId);
    await expect(session.extensions.call(QUERY, {})).resolves.toBe('isolates/1');
  });

  it('never sends a disallowed method or a caller-chosen isolate', async () => {
    const { server, session } = await attach();
    const before = server.calls.length;
    expect((await rejection(session.extensions.call('ext.flutter.exit', {}))).code).toBe(
      'not-allowed',
    );
    expect((await rejection(session.extensions.call('getVM', {}))).code).toBe('not-allowed');
    expect((await rejection(session.extensions.call(LIST, { isolateId: 'isolates/9' }))).code).toBe(
      'invalid-call',
    );
    expect(server.calls.length).toBe(before);
  });

  it('maps a missing extension, an extension error and a timeout to codes', async () => {
    const { server, session } = await attach();
    server
      .handle(QUERY, () => {
        throw new RpcFault(-32000, `bad query ${'x'.repeat(5000)}`);
      })
      .handle('ext.flutterdeck.drift.v1.hang', () => new Promise(() => undefined));
    expect((await rejection(session.extensions.call(LIST, {}))).code).toBe('not-found');
    const failed = await rejection(session.extensions.call(QUERY, {}));
    expect(failed.code).toBe('failed');
    expect(failed.message.startsWith('bad query')).toBe(true);
    expect(failed.message.length).toBeLessThanOrEqual(500);
    const slow = await rejection(
      session.extensions.call('ext.flutterdeck.drift.v1.hang', {}, { timeoutMs: 30 }),
    );
    expect(slow.code).toBe('timeout');
  });

  it('forgets a not-found extension so has() stops claiming it', async () => {
    const { session } = await attach();
    await rejection(session.extensions.call(LIST, {}));
    expect(session.extensions.has(LIST)).toBe(false);
  });

  it('follows the app across a hot restart: a collected isolate is retried once', async () => {
    const { server, session } = await attach();
    let mainId = 'isolates/1';
    server.handle('getVM', () => vmResponse(mainId));
    server.handle(LIST, (params) =>
      params?.isolateId === mainId ? { ok: true, on: mainId } : collectedSentinel,
    );
    mainId = 'isolates/2';
    await expect(session.extensions.call(LIST, {})).resolves.toEqual({
      ok: true,
      on: 'isolates/2',
    });
  });

  it('reports detached when the isolate stays collected or the app is gone', async () => {
    const { server, session } = await attach();
    server.handle(LIST, () => collectedSentinel);
    expect((await rejection(session.extensions.call(LIST, {}))).code).toBe('detached');
    server.disconnectAll();
    await vi.waitFor(() => expect(session.extensions.has(LIST)).toBe(false));
    expect((await rejection(session.extensions.call(LIST, {}))).code).toBe('detached');
  });

  it('drops the extensions of an isolate that exits', async () => {
    const { server, session } = await attach();
    server.notify(isolateEvent('IsolateExit', 'isolates/1'));
    await until(() => !session.extensions.has(LIST));
  });

  it('delivers events only from isolates that registered an allowed extension', async () => {
    const { server, session } = await attach();
    const cb = vi.fn();
    session.extensions.onEvent('flutterdeck.drift.tables', cb);
    server.notify(extensionEvent('flutterdeck.drift.tables', { db: 'other' }, 'isolates/5'));
    server.notify(extensionEvent('flutterdeck.drift.other', { db: 'app' }));
    server.notify(extensionEvent('flutterdeck.drift.tables', { db: 'app' }));
    await until(() => cb.mock.calls.length === 1);
    expect(cb).toHaveBeenCalledWith({ db: 'app' });
    expect(() => session.extensions.onEvent('Flutter.Frame', cb)).toThrow(AppExtensionError);
  });

  it('keeps delivering when an event listener throws', async () => {
    const { server, session } = await attach();
    const ok = vi.fn();
    session.extensions.onEvent('flutterdeck.drift.tables', () => {
      throw new Error('listener bug');
    });
    session.extensions.onEvent('flutterdeck.drift.tables', ok);
    server.notify(extensionEvent('flutterdeck.drift.tables', { n: 1 }));
    await until(() => ok.mock.calls.length === 1);
  });

  it('uses the prefixes it was given', async () => {
    server = await FakeRpcServer.start('/AbC=/ws');
    asFlutterVmService(server);
    session = await DartAppSession.attach(server.uri, app, {
      serviceWaitMs: 100,
      extensionPrefixes: () => ['ext.flutterdeck.other.'],
    });
    expect((await rejection(session.extensions.call(LIST, {}))).code).toBe('not-allowed');
  });

  it('keeps methods announced under a prefix that is allowed only later (D2)', async () => {
    const prefixes = ['ext.flutterdeck.other.'];
    server = await FakeRpcServer.start('/AbC=/ws');
    asFlutterVmService(server);
    server.handle('getIsolate', (params) => isolateResponse(String(params?.isolateId), [LIST]));
    server.handle(LIST, (params) => params?.isolateId);
    session = await DartAppSession.attach(server.uri, app, {
      serviceWaitMs: 100,
      extensionPrefixes: () => prefixes,
    });
    const s = session;
    server.notify(serviceExtensionAdded(QUERY, 'isolates/7'));
    server.notify(extensionEvent('flutterdeck.drift.tables', { early: true }, 'isolates/7'));
    // A round trip after the notifications: they have been handled once it answers.
    await s.reload();
    expect(s.extensions.has(LIST)).toBe(false);
    expect(s.extensions.has(QUERY)).toBe(false);
    prefixes.push('ext.flutterdeck.drift.');
    await until(() => s.extensions.has(QUERY));
    expect(s.extensions.has(LIST)).toBe(true);
    // The call goes to the isolate that announced the method, not the main one.
    server.handle(QUERY, (params) => params?.isolateId);
    await expect(s.extensions.call(QUERY, {})).resolves.toBe('isolates/7');
    const cb = vi.fn();
    s.extensions.onEvent('flutterdeck.drift.tables', cb);
    server.notify(extensionEvent('flutterdeck.drift.tables', { late: true }, 'isolates/7'));
    await until(() => cb.mock.calls.length === 1);
    expect(cb).toHaveBeenCalledWith({ late: true });
  });

  it('never makes a blocked method callable, whatever it announced', async () => {
    const { session } = await attach(['ext.flutter.exit']);
    expect(session.extensions.has('ext.flutter.exit')).toBe(false);
  });

  it('keeps allowed methods announced after 1,000 foreign ones (C7)', async () => {
    const foreign = Array.from({ length: 1000 }, (_, i) => `ext.other.m${i}`);
    const { server, session } = await attach([...foreign, LIST]);
    server.notify(serviceExtensionAdded(QUERY, 'isolates/1'));
    await until(() => session.extensions.has(QUERY));
    expect(session.extensions.has(LIST)).toBe(true);
  });

  it('keeps at most 10,000 allowed methods per session (N2)', async () => {
    const allowed = Array.from({ length: 10_005 }, (_, i) => `ext.flutterdeck.drift.m${i}`);
    const { session } = await attach(allowed);
    expect(session.extensions.has('ext.flutterdeck.drift.m0')).toBe(true);
    expect(session.extensions.has('ext.flutterdeck.drift.m9999')).toBe(true);
    expect(session.extensions.has('ext.flutterdeck.drift.m10000')).toBe(false);
  });
});
