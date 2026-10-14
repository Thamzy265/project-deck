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
const EXTERNAL_RESTART: ReloadResult = { ok: true, kind: 'hot-restart', source: 'external' };

/** getVM as the recorded app answers it: one main isolate in `group`. */
function vm(isolate: string, group: string) {
  const base = vmResponse(isolate);
  return {
    ...base,
    isolates: base.isolates.map((i) => ({ ...i, isolateGroupId: group })),
  };
}

async function attach(graceMs = 0) {
  const srv = await FakeRpcServer.start('/AbC=/ws');
  server = srv;
  asFlutterVmService(srv);
  srv.handle('getVM', () => vm(RECORDED_ISOLATE, RECORDED_GROUP));
  const s = await DartAppSession.attach(srv.uri, app, {
    serviceWaitMs: 100,
    ownReloadGraceMs: graceMs,
  });
  session = s;
  const results: ReloadResult[] = [];
  s.on('reloaded', (r) => results.push(r));
  return { server: srv, session: s, results };
}

/** After this the fake answers getVM as the restarted app does. */
function restartTheVm(srv: FakeRpcServer): void {
  srv.handle('getVM', () => vm(RECORDED_ISOLATE_AFTER_RESTART, RECORDED_GROUP_AFTER_RESTART));
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
    await vi.waitFor(() => expect(results).toEqual([EXTERNAL_RESTART, EXTERNAL_OK]));
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
    await vi.waitFor(() => expect(results).toEqual([EXTERNAL_RESTART, EXTERNAL_OK]));
    answer?.();
  });

  it('reports nothing for a hot_reload that failed to compile: the VM posts no event', async () => {
    const { server, results } = await attach();
    const events = recorded.reloadCompileError();
    expect(events).toEqual([]);
    for (const event of events) server.notify(event);
    await settle();
    expect(results).toEqual([]);
  });

  it('reports a hot restart by someone else once, then their reloads in the new group', async () => {
    const { server, results } = await attach();
    restartTheVm(server);
    for (const event of recorded.hotRestart()) server.notify(event);
    await vi.waitFor(() => expect(results).toEqual([EXTERNAL_RESTART]));
    server.notify(recorded.reloadAfterRestart());
    await vi.waitFor(() => expect(results).toEqual([EXTERNAL_RESTART, EXTERNAL_OK]));
  });

  it("does not report its own hot restart as someone else's", async () => {
    const { server, session, results } = await attach(1000);
    server.handle('s0.hotRestart', () => {
      restartTheVm(server);
      for (const event of recorded.hotRestart()) server.notify(event);
      return { type: 'Success' };
    });
    const own = await session.restart();
    await settle();
    expect(results).toEqual([own]);
    expect(own).toMatchObject({ ok: true, kind: 'hot-restart' });
    expect(own).not.toHaveProperty('source');
  });

  it('does not report its own hot restart when the events come just after the answer', async () => {
    const { server, session, results } = await attach(1000);
    server.handle('s0.hotRestart', () => {
      setTimeout(() => {
        restartTheVm(server);
        for (const event of recorded.hotRestart()) server.notify(event);
      }, 20);
      return { type: 'Success' };
    });
    const own = await session.restart();
    await settle(80);
    expect(results).toEqual([own]);
  });

  it('reports a restart by someone else after its own restart has settled', async () => {
    const { server, session, results } = await attach(30);
    server.handle('s0.hotRestart', () => {
      restartTheVm(server);
      for (const event of recorded.hotRestart()) server.notify(event);
      return { type: 'Success' };
    });
    await session.restart();
    await settle(60);
    // Someone else restarts back into a new group.
    server.handle('getVM', () => vm(RECORDED_ISOLATE, RECORDED_GROUP));
    for (const event of recorded.hotRestart().reverse()) {
      const kind = event.event.kind;
      if (kind === 'IsolateExit') continue;
      server.notify({
        ...event,
        event: {
          ...event.event,
          isolate: {
            type: '@Isolate',
            id: RECORDED_ISOLATE,
            name: 'main',
            isolateGroupId: RECORDED_GROUP,
          },
          isolateGroup: { type: '@IsolateGroup', id: RECORDED_GROUP },
        },
      });
    }
    await vi.waitFor(() => expect(results).toHaveLength(2));
    expect(results[1]).toEqual(EXTERNAL_RESTART);
  });
});
