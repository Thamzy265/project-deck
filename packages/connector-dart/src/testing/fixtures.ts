/**
 * Protocol messages for tests. Shapes come from the VM service spec
 * (sdk runtime/vm/service/service.md), pkg/dtd and flutter_tools' vmservice.dart,
 * plus the live Android Studio DTD responses recorded on 9 Oct 2026 (see
 * docs/notes/dtd.md). Replace with a full recorded session at M1 acceptance.
 */
import type { FakeRpcServer } from './fake-rpc-server.js';
import { RpcFault } from './fake-rpc-server.js';

export const registeredServicesResponse = {
  type: 'RegisteredServicesResponse',
  dtdServices: [
    'streamListen',
    'streamCancel',
    'postEvent',
    'registerService',
    'getRegisteredServices',
    'ConnectedApp.registerVmService',
    'ConnectedApp.unregisterVmService',
    'ConnectedApp.getVmServices',
    'FileSystem.readFileAsString',
  ],
  clientServices: [],
};

export const vmResponse = (mainIsolateId = 'isolates/1') => ({
  type: 'VM',
  name: 'vm',
  architectureBits: 64,
  hostCPU: 'arm64',
  operatingSystem: 'android',
  targetCPU: 'arm64',
  version: '3.12.2',
  pid: 4242,
  isolates: [
    {
      type: '@Isolate',
      id: mainIsolateId,
      number: '1',
      name: 'main',
      isSystemIsolate: false,
      isolateGroupId: 'isolateGroups/1',
    },
  ],
  systemIsolates: [
    {
      type: '@Isolate',
      id: 'isolates/9',
      number: '9',
      name: 'vm-service',
      isSystemIsolate: true,
      isolateGroupId: 'isolateGroups/9',
    },
  ],
});

export const serviceRegistered = (service: string, method: string) => ({
  streamId: 'Service',
  event: {
    type: 'Event',
    kind: 'ServiceRegistered',
    timestamp: 1,
    service,
    method,
    alias: 'Flutter Tools',
  },
});

export const writeEvent = (streamId: 'Stdout' | 'Stderr', text: string, timestamp = 1000) => ({
  streamId,
  event: {
    type: 'Event',
    kind: 'WriteEvent',
    timestamp,
    isolate: { type: '@Isolate', id: 'isolates/1', name: 'main' },
    bytes: Buffer.from(text, 'utf8').toString('base64'),
  },
});

const stringRef = (value: string, truncated = false) => ({
  type: '@Instance',
  kind: 'String',
  id: 'objects/1',
  valueAsString: value,
  ...(truncated ? { valueAsStringIsTruncated: true } : {}),
});
const nullRef = { type: '@Instance', kind: 'Null', id: 'objects/null', valueAsString: 'null' };

export const loggingEvent = (opts: {
  message: string;
  level?: number;
  loggerName?: string;
  error?: string;
  stackTrace?: string;
  time?: number;
}) => ({
  streamId: 'Logging',
  event: {
    type: 'Event',
    kind: 'Logging',
    timestamp: opts.time ?? 2000,
    logRecord: {
      type: 'LogRecord',
      message: stringRef(opts.message),
      time: opts.time ?? 2000,
      level: opts.level ?? 0,
      sequenceNumber: 1,
      loggerName: stringRef(opts.loggerName ?? ''),
      zone: nullRef,
      error: opts.error === undefined ? nullRef : stringRef(opts.error),
      stackTrace: opts.stackTrace === undefined ? nullRef : stringRef(opts.stackTrace),
    },
  },
});

export const isolateEvent = (
  kind: 'IsolateStart' | 'IsolateRunnable' | 'IsolateExit',
  id: string,
) => ({
  streamId: 'Isolate',
  event: { type: 'Event', kind, timestamp: 1, isolate: { type: '@Isolate', id, name: 'main' } },
});

export const success = { type: 'Success' };

/**
 * Makes a fake behave like an app's VM service behind DDS with the Flutter
 * tool attached: `s0.reloadSources` / `s0.hotRestart` are announced on the
 * Service stream as soon as it is subscribed.
 */
export function asFlutterVmService(
  server: FakeRpcServer,
  opts: { withFlutterTool?: boolean } = {},
): void {
  let isolateId = 'isolates/1';
  server
    .handle('streamListen', () => success)
    .handle('getVM', () => vmResponse(isolateId))
    // Like flutter_tools: the isolate id must be a non-empty string but is otherwise ignored.
    .handle('s0.reloadSources', (params) => {
      if (typeof params?.isolateId !== 'string' || params.isolateId === '')
        throw new RpcFault(-32602, "Invalid 'isolateId'");
      return success;
    })
    .handle('s0.hotRestart', () => {
      isolateId = `isolates/${Number(isolateId.split('/')[1]) + 1}`;
      server.notify(isolateEvent('IsolateExit', 'isolates/1'));
      server.notify(isolateEvent('IsolateStart', isolateId));
      return success;
    });
  if (opts.withFlutterTool === false) return;
  server.onStreamListen = (streamId, send) => {
    if (streamId !== 'Service') return;
    send(serviceRegistered('reloadSources', 's0.reloadSources'));
    send(serviceRegistered('hotRestart', 's0.hotRestart'));
  };
}

/** Makes a fake behave like a DTD with the given apps already registered. */
export function asDtd(server: FakeRpcServer, apps: { uri: string; name?: string }[]): void {
  server
    .handle('getRegisteredServices', () => registeredServicesResponse)
    .handle('streamListen', () => success)
    .handle('ConnectedApp.getVmServices', () => ({ type: 'VmServicesResponse', vmServices: apps }));
}

export const vmServiceRegistered = (uri: string, name: string) => ({
  streamId: 'ConnectedApp',
  eventKind: 'VmServiceRegistered',
  eventData: { uri, exposedUri: uri, name },
  timestamp: 1,
});

export const vmServiceUnregistered = (uri: string) => ({
  streamId: 'ConnectedApp',
  eventKind: 'VmServiceUnregistered',
  eventData: { uri, exposedUri: uri, name: null },
  timestamp: 2,
});
