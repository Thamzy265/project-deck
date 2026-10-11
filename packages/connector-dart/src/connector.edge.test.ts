import type { AddressInfo, Socket } from 'node:net';
import { createServer } from 'node:net';
import type { RunningApp } from '@project-deck/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DartConnector, appIdFor, normalise } from './connector.js';
import type { DtdInfo } from './discovery.js';
import { FakeRpcServer } from './testing/fake-rpc-server.js';
import { asDtd, asFlutterVmService, vmServiceRegistered } from './testing/fixtures.js';

const servers: FakeRpcServer[] = [];
let connector: DartConnector | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  // Close servers first: a hanging DTD only lets the scan (and so stop()) finish once its socket drops.
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await connector?.stop();
  connector = undefined;
});

async function dtd(apps: { uri: string; name?: string }[]): Promise<FakeRpcServer> {
  const s = await FakeRpcServer.start('/dtd-code');
  asDtd(s, apps);
  servers.push(s);
  return s;
}

/** A DTD that completes the WebSocket handshake and then never answers anything. */
async function hangingDtd(): Promise<FakeRpcServer> {
  const s = await FakeRpcServer.start('/dtd-code');
  s.handle('getRegisteredServices', () => new Promise(() => undefined));
  servers.push(s);
  return s;
}

function make(
  discover: () => Promise<DtdInfo[]>,
  extra: Partial<ConstructorParameters<typeof DartConnector>[0]> = {},
) {
  connector = new DartConnector({
    discover,
    scanIntervalMs: 0,
    session: { serviceWaitMs: 100 },
    log: () => undefined,
    ...extra,
  });
  return connector;
}

const APP = 'ws://127.0.0.1:7100/K=/ws';

describe('DartConnector edge cases', () => {
  it('keeps an app advertised by two DTDs when one of them closes', async () => {
    const ide = await dtd([{ uri: APP, name: 'from IDE' }]);
    const own = await dtd([{ uri: APP, name: 'from flutter run' }]);
    const c = make(() =>
      Promise.resolve([
        { wsUri: ide.uri, ideName: 'VS Code', source: 'pid-file' },
        { wsUri: own.uri, source: 'pid-file' },
      ]),
    );
    const changes = vi.fn<(apps: RunningApp[]) => void>();
    c.onAppsChanged(changes);
    await c.start();
    expect((await c.listApps()).map((a) => a.name)).toEqual(['from IDE']);

    ide.disconnectAll();
    await vi.waitFor(() =>
      expect(changes.mock.lastCall?.[0].map((a) => [a.id, a.name, a.startedBy])).toEqual([
        [appIdFor(APP), 'from flutter run', 'unknown'],
      ]),
    );
  });

  it('B5: apps from healthy DTDs are listed without waiting for a DTD that never answers', async () => {
    const good = await dtd([{ uri: APP, name: 'shop' }]);
    const stuck = await hangingDtd();
    const c = make(() =>
      Promise.resolve([
        { wsUri: stuck.uri, source: 'pid-file' },
        { wsUri: good.uri, source: 'pid-file' },
      ]),
    );
    const changes = vi.fn<(apps: RunningApp[]) => void>();
    c.onAppsChanged(changes);
    let started = false;
    void c.start().then(() => (started = true));
    await vi.waitFor(
      async () => expect((await c.listApps()).map((a) => a.name)).toEqual(['shop']),
      { timeout: 1500 },
    );
    expect(changes.mock.lastCall?.[0].map((a) => a.name)).toEqual(['shop']);
    // The first scan is still waiting on the stuck DTD.
    expect(started).toBe(false);
  });

  it('B6: stop() closes a DTD that never answers instead of waiting for the scan', async () => {
    const stuck = await hangingDtd();
    const c = make(() => Promise.resolve([{ wsUri: stuck.uri, source: 'pid-file' }]));
    void c.start();
    await vi.waitFor(() =>
      expect(stuck.calls.some((x) => x.method === 'getRegisteredServices')).toBe(true),
    );
    const stopped = c.stop().then(() => 'stopped');
    const timeout = new Promise((resolve) => setTimeout(() => resolve('still waiting'), 1000));
    expect(await Promise.race([stopped, timeout])).toBe('stopped');
    await vi.waitFor(() => expect(stuck.clientCount).toBe(0));
  });

  it('B6: stop() cancels a DTD handshake that never completes', async () => {
    // Accepts TCP and never answers the WebSocket upgrade.
    const sockets = new Set<Socket>();
    const tcp = createServer((socket) => sockets.add(socket));
    await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
    const { port } = tcp.address() as AddressInfo;
    try {
      const c = make(() =>
        Promise.resolve([{ wsUri: `ws://127.0.0.1:${port}/dtd`, source: 'pid-file' }]),
      );
      void c.start();
      await vi.waitFor(() => expect(sockets.size).toBe(1));
      const stopped = c.stop().then(() => 'stopped');
      const timeout = new Promise((resolve) => setTimeout(() => resolve('still waiting'), 1000));
      expect(await Promise.race([stopped, timeout])).toBe('stopped');
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => tcp.close(resolve));
    }
  });

  it('stop() during the first scan leaves no scan interval behind', async () => {
    let release: () => void = () => undefined;
    let scans = 0;
    const c = make(
      () => {
        scans++;
        if (scans > 1) return Promise.resolve([]);
        return new Promise<DtdInfo[]>((resolve) => {
          release = () => resolve([]);
        });
      },
      { scanIntervalMs: 10 },
    );
    const started = c.start();
    await vi.waitFor(() => expect(scans).toBe(1));
    const stopped = c.stop();
    release();
    await Promise.all([started, stopped]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(scans).toBe(1);
    expect((c as unknown as { timer: unknown }).timer).toBeUndefined();
  });

  it('does not retry a failed DTD before RETRY_AFTER_MS, then retries', async () => {
    const old = await FakeRpcServer.start('/old');
    servers.push(old);
    old.handle('getRegisteredServices', () => ({ dtdServices: ['streamListen'] }));
    const c = make(() => Promise.resolve([{ wsUri: old.uri, source: 'pid-file' }]));
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    await c.start();
    const attempts = () => old.calls.filter((x) => x.method === 'getRegisteredServices').length;
    expect(attempts()).toBe(1);

    clock.mockReturnValue(now + 29_000);
    await c.scan();
    expect(attempts()).toBe(1);

    clock.mockReturnValue(now + 30_001);
    await c.scan();
    expect(attempts()).toBe(2);
  });

  it('notifies onAppsChanged only when the app list actually changes', async () => {
    const d = await dtd([{ uri: APP, name: 'shop' }]);
    const c = make(() => Promise.resolve([{ wsUri: d.uri, source: 'pid-file' }]));
    const changes = vi.fn<(apps: RunningApp[]) => void>();
    c.onAppsChanged(changes);
    await c.start();
    expect(changes).toHaveBeenCalledOnce();
    await c.scan();
    await c.scan();
    // Re-registering the same app with the same name is not a change.
    d.notify(vmServiceRegistered(APP, 'shop'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(changes).toHaveBeenCalledOnce();

    d.notify(vmServiceRegistered(APP, 'renamed'));
    await vi.waitFor(() => expect(changes).toHaveBeenCalledTimes(2));
  });

  it('shares one pass between overlapping scans', async () => {
    let calls = 0;
    const c = make(() => {
      calls++;
      return new Promise((resolve) => setTimeout(() => resolve([]), 30));
    });
    await Promise.all([c.scan(), c.scan(), c.scan()]);
    expect(calls).toBe(1);
  });

  it('B8: the same VM service advertised as localhost and 127.0.0.1 is listed once', async () => {
    const a = await dtd([{ uri: 'ws://localhost:7200/L=/ws', name: 'shop' }]);
    const b = await dtd([{ uri: 'ws://127.0.0.1:7200/L=/ws', name: 'shop' }]);
    const c = make(() =>
      Promise.resolve([
        { wsUri: a.uri, source: 'pid-file' },
        { wsUri: b.uri, source: 'pid-file' },
      ]),
    );
    await c.start();
    expect(await c.listApps()).toHaveLength(1);
  });

  it('B8: keeps connecting to the address as advertised', async () => {
    const vm = await FakeRpcServer.start('/M=/ws');
    servers.push(vm);
    asFlutterVmService(vm);
    const port = new URL(vm.uri).port;
    const d = await dtd([{ uri: `ws://localhost:${port}/M=/ws`, name: 'shop' }]);
    const c = make(() => Promise.resolve([{ wsUri: d.uri, source: 'pid-file' }]));
    await c.start();
    const [app] = await c.listApps();
    expect(app?.id).toBe(appIdFor(`ws://127.0.0.1:${port}/M=/ws`));
    const known = (c as unknown as { known: Map<string, { vmServiceUri: string }> }).known;
    expect([...known.values()].map((k) => k.vmServiceUri)).toEqual([
      `ws://localhost:${port}/M=/ws`,
    ]);
    // The session dials the advertised localhost address, not the canonical key.
    const session = await c.attach(app?.id ?? '');
    expect(vm.calls.some((x) => x.method === 'getVM')).toBe(true);
    await session.detach();
  });

  it('B8: canonicalises every loopback spelling in the dedupe key only', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]'])
      expect(normalise(`http://${host}:7300/N=/`)).toBe('ws://127.0.0.1:7300/N=/ws');
    expect(normalise('ws://10.0.2.2:7300/N=/ws')).toBe('ws://10.0.2.2:7300/N=/ws');
    expect(normalise('not a uri')).toBeUndefined();
  });
});
