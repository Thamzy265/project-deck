# 0004. App extensions as an optional core capability

Date: 2026-10-16

## Status

Accepted (M3 plan approved by the PM, 16 Oct 2026)

## Context

The live Drift backend talks to `flutterdeck_drift` inside the app through VM service extensions (`ext.flutterdeck.drift.v1.*`) and listens for its `postEvent` events. CLAUDE.md keeps DTD and VM service specifics inside `connector-dart`, and packages depend on `core`, never on each other's internals. So `db-drift` cannot open its own VM service connection or import `connector-dart`.

## Decision

We will add an optional capability to `AppSession` in `core`:

```ts
interface AppExtensions {
  call(
    method: string,
    params: Record<string, string>,
    opts?: { timeoutMs?: number },
  ): Promise<unknown>;
  has(method: string): boolean;
  onEvent(kind: string, cb: (data: unknown) => void): () => void;
}
interface AppSession {
  /* … */ readonly extensions?: AppExtensions;
}
```

`connector-dart` implements it over the session's existing VM service connection (`callServiceExtension` on the main isolate, `Extension` stream for events, `ServiceExtensionAdded` to keep `has` current, follows the isolate after a hot restart). Method names must match `^ext\.[a-z0-9_.]+$`; `db-drift` uses only `ext.flutterdeck.drift.v1.*`. `FakeAppSession` in `core/testing` gets a fake implementation.

## Consequences

- `db-drift` depends on `core` only and works with any connector that offers extensions.
- `connector-dart` gains a small generic surface; the daemon never exposes `extensions.call` over HTTP or MCP directly (only through `DbInspector`), so no client can call arbitrary extensions.
- Other future adapters (Compose, web) can omit `extensions`; the Database tab then shows the snapshot or setup path.
