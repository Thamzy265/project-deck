/**
 * Reloads by others, driven by the Isolate stream QA recorded from a real app while the
 * Dart MCP server ran hot_reload and hot_restart (testing/fixtures/isolate-reload.recorded.json).
 */
import type { ReloadResult, RunningApp } from '@project-deck/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DartAppSession } from './session.js';
import { FakeRpcServer } from './testing/fake-rpc-server.js';
import {
  RECORDED_GROUP,
  RECORDED_GROUP_AFTER_RESTART,
  RECORDED_ISOLATE,
  RECORDED_ISOLATE_AFTER_RESTART,
  asFlutterVmService,
  recorded,
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

const EXTERNAL_OK: ReloadResult = { ok: true, kind: 'hot-reload', source: 'external' };

/** getVM as the recorded app answers it: one main isolate in `group`. */
function vm(isolate: string, group: string) {
  const base = vmResponse(isolate);
  return {
    ...base,
    isolates: base.isolates.map((i) => ({ ...i, isolateGroupId: group })),
  };
}

async function attach() {
  const srv = await FakeRpcServer.start('/AbC=/ws');
  server = srv;
  asFlutterVmService(srv);
  srv.handle('getVM', () => vm(RECORDED_ISOLATE, RECORDED_GROUP));
  const s = await DartAppSession.attach(srv.uri, app, { serviceWaitMs: 100, ownReloadGraceMs: 0 });
  session = s;
  const results: ReloadResult[] = [];
  s.on('reloaded', (r) => results.push(r));
  return { server: srv, results };
}

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('DartAppSession with the recorded Isolate stream', () => {
  it('reports a recorded hot_reload by the Dart MCP server', async () => {
    const { server, results } = await attach();
    server.notify(recorded.reloadSuccess());
    await vi.waitFor(() => expect(results).toEqual([EXTERNAL_OK]));
  });

  // Documented limitation (docs/notes/dtd.md): the VM says "success" for a reload it
  // rejected, and nothing else on the wire tells them apart, so it is reported as ok.
  it('reports a reload the VM rejected as ok, as the VM says', async () => {
    const { server, results } = await attach();
    server.notify(recorded.reloadRejectedByVm());
    await vi.waitFor(() => expect(results).toEqual([EXTERNAL_OK]));
  });

  it('follows the new isolate group after a hot restart by someone else', async () => {
    const { server, results } = await attach();
    server.handle('getVM', () => vm(RECORDED_ISOLATE_AFTER_RESTART, RECORDED_GROUP_AFTER_RESTART));
    for (const event of recorded.hotRestart()) server.notify(event);
    await settle();
    server.notify(recorded.reloadAfterRestart());
    await vi.waitFor(() => expect(results).toEqual([EXTERNAL_OK]));
  });

  it('sees a reload in the new group even before getVM has answered after the restart', async () => {
    const { server, results } = await attach();
    let answer: (() => void) | undefined;
    server.handle(
      'getVM',
      () =>
        new Promise((resolve) => {
          answer = () => resolve(vm(RECORDED_ISOLATE_AFTER_RESTART, RECORDED_GROUP_AFTER_RESTART));
        }),
    );
    for (const event of recorded.hotRestart()) server.notify(event);
    server.notify(recorded.reloadAfterRestart());
    await vi.waitFor(() => expect(results).toEqual([EXTERNAL_OK]));
    answer?.();
  });

  it('reports nothing for the restart itself', async () => {
    const { server, results } = await attach();
    server.handle('getVM', () => vm(RECORDED_ISOLATE_AFTER_RESTART, RECORDED_GROUP_AFTER_RESTART));
    for (const event of recorded.hotRestart()) server.notify(event);
    await settle();
    expect(results).toEqual([]);
  });
});
