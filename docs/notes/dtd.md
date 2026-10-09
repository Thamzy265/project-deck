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
- Results: success is `{type:"Success"}`. Failure is JSON-RPC error -32603 ("Unable to reload sources" / "Unable to restart") with empty details. **Compile error text is not available through this path.** The Dart MCP server has the same limitation.
- Don't call `ext.flutter.reassemble`; `reloadSources` already does it.

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
