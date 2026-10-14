# DTD and VM service notes

Checked against source on 9 Oct 2026: dart-lang/sdk main (`pkg/dtd`, `pkg/dtd_impl`, `pkg/dds`, `pkg/dart_data_home`), dart-lang/ai (`dart_mcp_server`), flutter/flutter (`flutter_tools`), Dart-Code, flutter-intellij. Re-verify before relying on anything marked unverified.

## DTD wire protocol

- JSON-RPC 2.0 over WebSocket at `ws://127.0.0.1:<port>/<authCode>`. A wrong auth code gets a 403. Newer builds also check `Host` and `Origin` are loopback.
- Core methods: `streamListen{streamId}`, `streamCancel{streamId}`, `postEvent{streamId,eventKind,eventData}`, `registerService{service,method,capabilities?}`, `getRegisteredServices` (returns `{dtdServices: string[], clientServices: [...]}`).
- Events arrive as `streamNotify{streamId,eventKind,eventData,timestamp}`. Service methods are called as `"<Service>.<method>"`.
- **Running apps:** call `ConnectedApp.getVmServices{}` (no secret needed), which returns `{vmServices: [{uri, exposedUri?, name?}]}`. Subscribe to stream `ConnectedApp` for the events `VmServiceRegistered` and `VmServiceUnregistered`, whose `eventData` is `{uri, exposedUri, name}`. Check support first: `ConnectedApp.getVmServices` must appear in `getRegisteredServices().dtdServices`.
- `ConnectedApp.registerVmService` needs the trusted-client secret, which only the process that spawned DTD has. **We never register apps ourselves.**
- **Who registers apps:**
  - `flutter run`: DDS starts its own DTD per app and registers that app in it.
  - VS Code (Dart-Code): one DTD per window, and each debug session is registered in it.
  - Android Studio / IntelliJ: one DTD, and each app is registered by its app ID.
  - The same app may appear in more than one DTD, so de-duplicate by VM service URI.

## Verified live (9 Oct 2026, Android Studio DTD, Dart 3.12.2)

- `getRegisteredServices` and `ConnectedApp.getVmServices` respond as described above.
- **Gotcha:** methods with no parameters must omit `params` entirely. Sending `params: {}` returns error -32602 "No parameters are allowed".
- Android Studio keeps one long-lived DTD and registers apps inside it, so running an app from the IDE does not create a new pid file. Check the app list instead (`node scripts/dtd-apps.mjs`).

## Finding DTDs

Every DTD on Dart 3.12+ writes a pid file at `<DartDataHome>/dtd/<pid>`, containing JSON `{wsUri, epoch, pid, dartVersion, workspaceRoot, ideName?}`.

| OS      | DartDataHome                                       |
| ------- | -------------------------------------------------- |
| Any     | `$DART_DATA_HOME` if set                           |
| macOS   | `~/Library/Application Support/Dart`               |
| Linux   | `$XDG_STATE_HOME/Dart`, else `~/.local/state/Dart` |
| Windows | `%LOCALAPPDATA%\Dart`                              |

- Stale files are left behind, so check the pid is alive and that the WebSocket connects before using an entry.
- `workspaceRoot` is DTD's working directory, not the project. Android Studio's points at the SDK.
- `dart tooling-daemon --list --machine` prints the same entries as JSON.
- Manual options: "Dart: Copy DTD URI to Clipboard" in VS Code, "Copy DTD URI" action in Android Studio, `flutter --print-dtd run` (hidden flag).

## Reload and restart

- flutter_tools registers the services `reloadSources` and `hotRestart` on the app's VM service. DDS namespaces them as `s<N>.<name>`.
- To find the callable name, `streamListen{streamId:"Service"}`. DDS replays existing registrations as `ServiceRegistered{service, method, alias}`; call the `method` value.
- Params: `reloadSources{isolateId, force?, pause?}`, `hotRestart{pause?}`.
- Results: success is `{type:"Success"}`. Failure arrives on the wire as `{"code":-32603,"message":""}`. flutter_tools throws `RPCError('Unable to reload sources' | 'Unable to restart', -32603, '')`, but that first argument is vm_service's `callingMethod`, which is never serialised. So treat -32603 from the Flutter tool's own service as a failed reload and **don't match on message text**. Corrected 12 Oct 2026 after review. **Compile error text is not available through this path.** The Dart MCP server has the same limitation.
- Don't call `ext.flutter.reassemble`; `reloadSources` already does it.

### Reloads made by others (checked 14 Oct 2026, verified live the same day)

Checked against dart-lang/sdk main: `runtime/vm/service/service.md` (header says protocol 4.23, body still says 4.22), `runtime/vm/service_event.cc` and `runtime/vm/isolate_reload.cc`. Then verified by QA on a real app (Flutter 3.44.6, Dart 3.12.2, Android emulator) with the official Dart MCP server's `hot_reload` and `hot_restart`. The recording is `packages/connector-dart/src/testing/fixtures/isolate-reload.recorded.json`; evidence is in `docs/qa/M2.md`.

- The event is `IsolateReload` on the `Isolate` stream. The VM posts it for a hot reload of an isolate group, whoever asked for it (Claude through the Dart MCP server, the IDE, `flutter run`'s `r`, or us).
- It is posted per isolate group and skips system groups. It carries `isolateGroup` and **no `isolate`**. FlutterDeck matches the group against the main isolate's group.
- The spec allows `status: "failure"` with `reloadFailureReason`, but no recorded case produced one:
  - **A reload that fails to compile posts no event at all.** flutter_tools stops before it asks the VM, so a compile error by someone else doesn't show in Activity. (The batch-5 PostToolUse hook is meant to report Claude's failed reloads.)
  - **A reload the VM rejects (for example an enum redefined as a class) posts `status: "success"`**, with no `reloadFailureReason`. No other event on the Isolate, Debug, Extension, Service, VM or Timeline streams tells it apart. Lead decision: FlutterDeck reports what the VM says, so such a reload shows as "Reloaded" in Activity. This is a known limitation.
  - The connector still handles `"failure"` (spec-built tests) in case another VM or tool posts it.
- A reload with no changed libraries posts no event, so such a reload by someone else doesn't show in Activity.
- **A hot restart posts no `IsolateReload`** (verified). It posts `IsolateExit` for the old main isolate, then `IsolateStart` and `IsolateRunnable` for a new main isolate in a **new isolate group**. The connector takes the new group straight from those events, so later reloads are matched at once. When the main isolate moves to a new group without an own restart, it reports a hot restart by someone else (`kind: "hot-restart"`, `source: "external"`).
- Our own reloads and restarts produce the same signals. The connector matches at most one signal per own action: an `IsolateReload` per own hot reload, a group change per own hot restart. The signal is matched while the action runs or up to 1 s after its answer, because the signal and the answer take different routes.
- **Known gap, accepted (review finding C4):** an own reload with no changed libraries, or one that fails to compile, posts no event, and the Flutter tool's answer (`{type: "Success"}`, or error -32603) doesn't say whether one is coming. So for 1 s after such a reload, a reload by someone else is taken for ours and doesn't show in Activity. A test pins this behaviour (`session.test.ts`).

## Logs

- VM service streams: `Stdout`, `Stderr` (`WriteEvent`, `bytes` base64) and `Logging` (`logRecord` with `message`, `loggerName`, `error`, `stackTrace` as `@Instance`, plus `time`, `level` 0–2000 using package:logging values, and `sequenceNumber`).
- `print` sends the text and the `\n` as separate events, so buffer by line.
- DDS keeps a 10,000-event history and replays it on the first `streamListen`, so attaching late still gets recent logs.

## Clients

There is no maintained npm client for DTD or the VM service, so we'll write a small JSON-RPC client over `ws`. Dart-Code's MIT-licensed `src/shared/services/tooling_daemon.ts` and `src/debug/dart_debug_protocol.ts` are good references.

## Unverified

- How DDS picks `N` in `s<N>`.
- Whether IDE-launched apps really appear in both the IDE DTD and their own DDS DTD.
- Exactly when stdout capture starts.
- Whether the Aug 2026 Host/Origin hardening has reached a stable SDK.
