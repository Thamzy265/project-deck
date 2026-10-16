/**
 * Tester probes of app extensions over the VM service (ADR 0004): hostile names, odd
 * events, hot restart races and the Collected-sentinel retry. Messages are built from
 * the spec-built fixtures in testing/fixtures.ts.
 */
import type { RunningApp } from '@project-deck/core';
import { AppExtensionError } from '@project-deck/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DartAppSession } from './session.js';
import { FakeRpcServer } from './testing/fake-rpc-server.js';
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
const KIND = 'flutterdeck.drift.tables';
let server: FakeRpcServer | undefined;
let session: DartAppSession | undefined;

afterEach(async () => {
  await session?.detach();
  await server?.close();
  session = undefined;
  server = undefined;
});

async function attach(extensionRPCs: string[] = [LIST]) {
  server = await FakeRpcServer.start('/AbC=/ws');
  asFlutterVmService(server);
  server.handle('getIsolate', (params) =>
    isolateResponse(String(params?.isolateId), extensionRPCs),
  );
  session = await DartAppSession.attach(server.uri, app, { serviceWaitMs: 100 });
  return { server, session };
}

const until = (check: () => boolean) => vi.waitFor(() => expect(check()).toBe(true));
const callsTo = (s: FakeRpcServer, method: string) => s.calls.filter((c) => c.method === method);

async function codeOf(p: Promise<unknown>): Promise<string> {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  return err instanceof AppExtensionError ? err.code : `not an AppExtensionError: ${String(err)}`;
}

/** Sends a marker event from the owning isolate and waits for it, so earlier ones were seen. */
async function flush(s: FakeRpcServer, seen: () => unknown[]) {
  s.notify(extensionEvent(KIND, { marker: true }));
  await until(() => seen().some((d) => typeof d === 'object' && d !== null && 'marker' in d));
}

describe('DartAppSession extensions under attack', () => {
  it('never sends a blocked or look-alike method, whatever the app announces', async () => {
    const { server, session } = await attach([
      'ext.flutter.exit',
      'ext.drift.database',
      'ext.Flutterdeck.x',
    ]);
    server.notify(serviceExtensionAdded('ext.flutter.reassemble', 'isolates/1'));
    server.notify(serviceExtensionAdded('ext.flutterdeckx.y', 'isolates/1'));
    server.notify(serviceExtensionAdded(LIST, 'isolates/1'));
    await until(() => session.extensions.has(LIST));
    const before = server.calls.length;
    for (const method of [
      'ext.flutter.exit',
      'ext.drift.database',
      'ext.Flutterdeck.x',
      'ext.flutter.reassemble',
      'ext.flutterdeckx.y',
      'ext.flutterdeck',
      'getIsolate',
      'kill',
    ]) {
      expect(session.extensions.has(method), method).toBe(false);
      expect(await codeOf(session.extensions.call(method, {})), method).toBe('not-allowed');
    }
    expect(server.calls.length).toBe(before);
  });

  it('sends nothing for invalid or oversized parameters', async () => {
    const { server, session } = await attach();
    const before = server.calls.length;
    expect(await codeOf(session.extensions.call(LIST, { isolateId: 'isolates/9' }))).toBe(
      'invalid-call',
    );
    expect(await codeOf(session.extensions.call(LIST, { sql: 'x'.repeat(256 * 1024 + 1) }))).toBe(
      'invalid-call',
    );
    const notString = { n: 1 } as unknown as Record<string, string>;
    expect(await codeOf(session.extensions.call(LIST, notString))).toBe('invalid-call');
    expect(server.calls.length).toBe(before);
  });

  it('always sends its own isolateId, the one that announced the method', async () => {
    const { server, session } = await attach([]);
    server.handle(LIST, (params) => params);
    server.notify(serviceExtensionAdded(LIST, 'isolates/7'));
    await until(() => session.extensions.has(LIST));
    await expect(session.extensions.call(LIST, { isolateid: 'isolates/1' })).resolves.toEqual({
      isolateid: 'isolates/1',
      isolateId: 'isolates/7',
    });
  });

  it('survives malformed Extension events and still delivers good ones', async () => {
    const { server, session } = await attach();
    const seen: unknown[] = [];
    session.extensions.onEvent(KIND, (d) => seen.push(d));
    const errors = vi.fn();
    session.on('error', errors);
    const bad: unknown[] = [
      {
        streamId: 'Extension',
        event: { type: 'Event', kind: 'Extension', extensionKind: KIND, extensionData: 1 },
      },
      {
        streamId: 'Extension',
        event: {
          type: 'Event',
          kind: 'Extension',
          isolate: { id: 'isolates/1' },
          extensionKind: 42,
          extensionData: {},
        },
      },
      {
        streamId: 'Extension',
        event: { type: 'Event', kind: 'Extension', isolate: { id: 'isolates/1' } },
      },
      {
        streamId: 'Extension',
        event: {
          type: 'Event',
          kind: 'NotExtension',
          isolate: { id: 'isolates/1' },
          extensionKind: KIND,
          extensionData: 'x',
        },
      },
      { streamId: 'Extension', event: 'garbage' },
      { streamId: 'Extension' },
      { streamId: 'NoSuchStream', event: { kind: 'Extension' } },
      'not an object',
    ];
    for (const params of bad) server.notify(params);
    server.notify(extensionEvent(KIND, 'a string payload'));
    server.notify(extensionEvent(KIND, null));
    await flush(server, () => seen);
    expect(seen).toEqual(['a string payload', null, { marker: true }]);
    expect(errors).not.toHaveBeenCalled();
  });

  it('drops events from isolates that announced nothing allowed, and from exited ones', async () => {
    const { server, session } = await attach();
    const seen: unknown[] = [];
    session.extensions.onEvent(KIND, (d) => seen.push(d));
    server.notify(serviceExtensionAdded('ext.flutter.exit', 'isolates/3'));
    server.notify(extensionEvent(KIND, { from: 3 }, 'isolates/3'));
    server.notify(serviceExtensionAdded('ext.flutterdeck.drift.v1.diff', 'isolates/4'));
    server.notify(extensionEvent(KIND, { from: 4 }, 'isolates/4'));
    server.notify(isolateEvent('IsolateExit', 'isolates/4'));
    server.notify(extensionEvent(KIND, { from: 'gone 4' }, 'isolates/4'));
    await flush(server, () => seen);
    expect(seen).toEqual([{ from: 4 }, { marker: true }]);
  });

  it('follows a hot restart that lands while a call is in flight', async () => {
    const { server, session } = await attach();
    let release: (() => void) | undefined;
    server.handle('getVM', () => vmResponse('isolates/2'));
    server.handle(LIST, (params) => {
      if (params?.isolateId === 'isolates/2') return { on: 'isolates/2' };
      return new Promise((resolve) => {
        release = () => resolve(collectedSentinel);
      });
    });
    const pending = session.extensions.call(LIST, {});
    await until(() => release !== undefined);
    server.notify(isolateEvent('IsolateExit', 'isolates/1'));
    server.notify(serviceExtensionAdded(LIST, 'isolates/2'));
    await until(() => session.extensions.has(LIST));
    release?.();
    await expect(pending).resolves.toEqual({ on: 'isolates/2' });
  });

  it('retries a Collected sentinel at most once, then reports detached', async () => {
    const { server, session } = await attach([]);
    server.handle(LIST, () => collectedSentinel);
    server.notify(serviceExtensionAdded(LIST, 'isolates/7'));
    await until(() => session.extensions.has(LIST));
    expect(await codeOf(session.extensions.call(LIST, {}))).toBe('detached');
    expect(callsTo(server, LIST).map((c) => c.params?.isolateId)).toEqual([
      'isolates/7',
      'isolates/1',
    ]);
    expect(session.extensions.has(LIST)).toBe(false);
  });

  it('does not retry when the main isolate is the one that stays collected', async () => {
    const { server, session } = await attach();
    server.handle(LIST, () => collectedSentinel);
    expect(await codeOf(session.extensions.call(LIST, {}))).toBe('detached');
    expect(callsTo(server, LIST)).toHaveLength(1);
  });

  it('answers detached at once when the VM goes away mid-call', async () => {
    const { server, session } = await attach();
    server.handle(LIST, () => new Promise(() => undefined));
    const pending = session.extensions.call(LIST, {}, { timeoutMs: 30_000 });
    await until(() => callsTo(server, LIST).length === 1);
    server.disconnectAll();
    expect(await codeOf(pending)).toBe('detached');
  });

  it('keeps calls independent when many run at once', async () => {
    const { server, session } = await attach();
    server.handle(LIST, (params) => ({ n: params?.n }));
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => session.extensions.call(LIST, { n: String(i) })),
    );
    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => ({ n: String(i) })));
  });
});
