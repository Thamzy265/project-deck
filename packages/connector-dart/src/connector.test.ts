import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunningApp } from '@project-deck/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DartConnector, appIdFor } from './connector.js';
import type { DtdInfo } from './discovery.js';
import { FakeRpcServer } from './testing/fake-rpc-server.js';
import {
  asDtd,
  asFlutterVmService,
  vmResponse,
  vmServiceRegistered,
  vmServiceUnregistered,
} from './testing/fixtures.js';

const servers: FakeRpcServer[] = [];
let connector: DartConnector | undefined;

afterEach(async () => {
  await connector?.stop();
  connector = undefined;
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function vmService(): Promise<FakeRpcServer> {
  const s = await FakeRpcServer.start('/AbC=/ws');
  asFlutterVmService(s);
  servers.push(s);
  return s;
}

async function dtd(apps: { uri: string; name?: string }[]): Promise<FakeRpcServer> {
  const s = await FakeRpcServer.start('/dtd-code');
  asDtd(s, apps);
  servers.push(s);
  return s;
}

function make(
  dtds: DtdInfo[],
  extra: Partial<ConstructorParameters<typeof DartConnector>[0]> = {},
) {
  connector = new DartConnector({
    discover: () => Promise.resolve(dtds),
    scanIntervalMs: 0,
    session: { serviceWaitMs: 100 },
    log: () => undefined,
    ...extra,
  });
  return connector;
}

describe('DartConnector', () => {
  it('lists apps registered in a DTD under opaque ids', async () => {
    const vm = await vmService();
    const d = await dtd([{ uri: vm.uri, name: 'shop' }]);
    const c = make([{ wsUri: d.uri, ideName: 'Android Studio', source: 'pid-file' }]);
    await c.start();
    const apps = await c.listApps();
    expect(apps).toEqual([
      { id: appIdFor(vm.uri), name: 'shop', framework: 'flutter', startedBy: 'ide' },
    ]);
    expect(JSON.stringify(apps)).not.toContain('AbC=');
    // Read-only: we never call registerVmService, and parameterless calls omit params.
    expect(d.calls.map((x) => x.method)).not.toContain('ConnectedApp.registerVmService');
    expect(d.calls.find((x) => x.method === 'ConnectedApp.getVmServices')?.hadParams).toBe(false);
  });

  it('tracks apps starting and stopping, and drops them when the DTD goes away', async () => {
    const d = await dtd([]);
    const c = make([{ wsUri: d.uri, source: 'pid-file' }]);
    const changes = vi.fn<(apps: RunningApp[]) => void>();
    c.onAppsChanged(changes);
    await c.start();
    expect(await c.listApps()).toEqual([]);

    d.notify(vmServiceRegistered('ws://127.0.0.1:7000/X=/ws', 'shop'));
    await vi.waitFor(() => expect(changes.mock.lastCall?.[0].map((a) => a.name)).toEqual(['shop']));
    expect(changes.mock.lastCall?.[0][0]?.startedBy).toBe('unknown');

    d.notify(vmServiceUnregistered('ws://127.0.0.1:7000/X=/ws'));
    await vi.waitFor(() => expect(changes.mock.lastCall?.[0]).toEqual([]));

    d.notify(vmServiceRegistered('ws://127.0.0.1:7001/Y=/ws', 'again'));
    await vi.waitFor(() => expect(changes.mock.lastCall?.[0].length).toBe(1));
    d.disconnectAll();
    await vi.waitFor(() => expect(changes.mock.lastCall?.[0]).toEqual([]));
  });

  it('merges an app seen by two DTDs and prefers the IDE entry', async () => {
    const uri = 'ws://127.0.0.1:7002/Z=/ws';
    const ide = await dtd([{ uri, name: 'from IDE' }]);
    const own = await dtd([{ uri: uri.replace(/\/ws$/, '/ws/'), name: 'from flutter run' }]);
    const c = make([
      { wsUri: own.uri, source: 'pid-file' },
      { wsUri: ide.uri, ideName: 'VS Code', source: 'pid-file' },
    ]);
    await c.start();
    expect((await c.listApps()).map((a) => [a.name, a.startedBy])).toEqual([['from IDE', 'ide']]);
  });

  it('ignores non-loopback app addresses and DTDs without ConnectedApp', async () => {
    const d = await dtd([{ uri: 'ws://198.51.100.7:7000/X=/ws', name: 'remote' }]);
    const old = await FakeRpcServer.start('/old');
    servers.push(old);
    old.handle('getRegisteredServices', () => ({ dtdServices: ['streamListen'] }));
    const log = vi.fn();
    const c = make(
      [
        { wsUri: d.uri, source: 'pid-file' },
        { wsUri: old.uri, source: 'pid-file' },
      ],
      { log },
    );
    await c.start();
    expect(await c.listApps()).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('Could not use DTD'),
      expect.any(Error),
    );
  });

  it('includes pasted VM service addresses and attaches to them', async () => {
    const vm = await vmService();
    const c = make([], { vmServiceUris: [vm.uri, 'ws://203.0.113.1:1/x=/ws'] });
    await c.start();
    const [app] = await c.listApps();
    expect(app?.name).toBe('Dart app (pasted address)');
    const session = await c.attach(app?.id ?? '');
    expect(await session.reload()).toMatchObject({ ok: true });
  });

  it('skips unparseable app addresses from DTDs and pasted lists', async () => {
    const vm = await vmService();
    const d = await dtd([
      { uri: 'not a uri', name: 'broken' },
      { uri: vm.uri, name: 'shop' },
    ]);
    const log = vi.fn();
    const c = make([{ wsUri: d.uri, source: 'pid-file' }], {
      vmServiceUris: ['::nonsense::'],
      log,
    });
    const changes = vi.fn<(apps: RunningApp[]) => void>();
    c.onAppsChanged(changes);
    await c.start();
    expect((await c.listApps()).map((a) => a.name)).toEqual(['shop']);

    d.notify(vmServiceRegistered('also not a uri', 'broken again'));
    d.notify(vmServiceRegistered('ws://127.0.0.1:7003/Q=/ws', 'second'));
    await vi.waitFor(() =>
      expect(changes.mock.lastCall?.[0].map((a) => a.name)).toEqual(['shop', 'second']),
    );
    await c.scan();
    expect(log).not.toHaveBeenCalled();
  });

  it('logs a failing background scan instead of leaving the rejection unhandled', async () => {
    const boom = new Error('discovery broke');
    let calls = 0;
    const log = vi.fn();
    const c = make([], {
      discover: () => (calls++ === 0 ? Promise.resolve([]) : Promise.reject(boom)),
      scanIntervalMs: 10,
      log,
    });
    await c.start();
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('Background scan failed', boom));
  });

  it('detaches a session whose attach finishes after stop', async () => {
    const vm = await vmService();
    let release: () => void = () => undefined;
    vm.handle(
      'getVM',
      () =>
        new Promise((resolve) => {
          release = () => resolve(vmResponse());
        }),
    );
    const c = make([], { vmServiceUris: [vm.uri] });
    await c.start();
    const [app] = await c.listApps();
    const attaching = c.attach(app?.id ?? '');
    await vi.waitFor(() => expect(vm.calls.some((x) => x.method === 'getVM')).toBe(true));
    await c.stop();
    release();
    await expect(attaching).rejects.toThrow(/stopped while attaching/);
    await vi.waitFor(() => expect(vm.clientCount).toBe(0));
  });

  it('attaches end to end through a DTD and detaches on stop', async () => {
    const vm = await vmService();
    const d = await dtd([{ uri: vm.uri, name: 'shop' }]);
    const c = make([{ wsUri: d.uri, source: 'manual' }]);
    await c.start();
    const session = await c.attach(appIdFor(vm.uri));
    expect(await session.restart()).toMatchObject({ ok: true, kind: 'hot-restart' });
    await c.stop();
    await vi.waitFor(() => expect(vm.clientCount + d.clientCount).toBe(0));
    await expect(c.attach('dart-unknown')).rejects.toThrow(/No running Dart app/);
  });
  it('runs the dart CLI fallback at most once a minute when there is no pid-file directory', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const dartCli = vi.fn(() => Promise.resolve<DtdInfo[]>([]));
    connector = new DartConnector({
      dataHome: join(tmpdir(), 'deck-no-such-dart-home'),
      dartCli,
      scanIntervalMs: 0,
      log: () => undefined,
    });
    await connector.start();
    await connector.scan();
    now += 59_000;
    await connector.scan();
    expect(dartCli).toHaveBeenCalledTimes(1);
    now += 1_000;
    await connector.scan();
    expect(dartCli).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });
});
