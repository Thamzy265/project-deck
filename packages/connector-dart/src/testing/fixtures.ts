/**
 * Protocol messages for tests. Shapes come from the VM service spec
 * (sdk runtime/vm/service/service.md), pkg/dtd and flutter_tools' vmservice.dart,
 * plus the live Android Studio DTD responses recorded on 9 Oct 2026 (see
 * docs/notes/dtd.md). Replace with a full recorded session at M1 acceptance.
 */
import { readFileSync } from 'node:fs';
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
      isolateGroupId: RECORDED_GROUP,
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

/** Raw `streamNotify` params as recorded: the event's fields are kept as they came. */
export interface RecordedNotify {
  streamId: string;
  event: Record<string, unknown>;
}

interface RecordedCase {
  isolateStream: RecordedNotify[];
}

/**
 * RECORDED by QA on 14 Oct 2026 from a real app with the official Dart MCP server's
 * `hot_reload` and `hot_restart` (see the file's `_source` and `findings`). Read lazily:
 * the testing folder isn't built, so the JSON only has to exist next to the source.
 */
function recordedCases(): Record<string, RecordedCase> {
  const url = new URL('./fixtures/isolate-reload.recorded.json', import.meta.url);
  const file = JSON.parse(readFileSync(url, 'utf8')) as { cases: Record<string, RecordedCase> };
  return file.cases;
}

function recordedCase(name: string): RecordedNotify[] {
  const found = recordedCases()[name];
  if (found === undefined) throw new Error(`No recorded case '${name}'`);
  return structuredClone(found.isolateStream);
}

function onlyEvent(name: string): RecordedNotify {
  const [event, ...rest] = recordedCase(name);
  if (event === undefined || rest.length > 0) throw new Error(`Case '${name}' isn't one event`);
  return event;
}

export const recorded = {
  /** A successful `hot_reload`: one IsolateReload, status "success", no isolate field. */
  reloadSuccess: () => onlyEvent('reloadSuccess'),
  /** A reload the VM rejected (enum changed to a class): still status "success". */
  reloadRejectedByVm: () => onlyEvent('reloadRejectedByVm'),
  /** A `hot_restart`: IsolateExit, then IsolateStart and IsolateRunnable in a new group. */
  hotRestart: () => recordedCase('hotRestart'),
  /** The first `hot_reload` after that restart, in the new group. */
  reloadAfterRestart: () => onlyEvent('reloadAfterRestart'),
};

/** The recorded app's main isolate and its group, before and after the hot restart. */
export const RECORDED_GROUP = 'isolateGroups/6767947138351398';
export const RECORDED_ISOLATE = 'isolates/8250619321730395';
export const RECORDED_GROUP_AFTER_RESTART = 'isolateGroups/4231576654569566';
export const RECORDED_ISOLATE_AFTER_RESTART = 'isolates/4820636724564003';

/**
 * An `IsolateReload` event. Without options it is the RECORDED successful reload.
 * With options it is SPEC-BUILT, because the recording has no equivalent: the VM posted
 * no `status: "failure"` in any recorded case (a compile error posts nothing; a rejected
 * reload says "success"), and no event of another group. Shaped from the VM service spec
 * (service.md) and source (service_event.cc: `isolateGroup`, `status`,
 * `reloadFailureReason`), checked 14 Oct 2026.
 */
export function isolateReloadEvent(
  opts: { failureReason?: string; isolateGroupId?: string } = {},
): RecordedNotify {
  if (opts.failureReason === undefined && opts.isolateGroupId === undefined) {
    return recorded.reloadSuccess();
  }
  return {
    streamId: 'Isolate',
    event: {
      type: 'Event',
      kind: 'IsolateReload',
      timestamp: 3,
      isolateGroup: {
        type: '@IsolateGroup',
        id: opts.isolateGroupId ?? RECORDED_GROUP,
        name: 'main.dart',
        number: '1',
        isSystemIsolateGroup: false,
      },
      ...(opts.failureReason === undefined
        ? { status: 'success' }
        : { status: 'failure', reloadFailureReason: opts.failureReason }),
    },
  };
}

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
      // The VM posts IsolateReload during the reload, before the Flutter tool answers.
      server.notify(isolateReloadEvent());
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
