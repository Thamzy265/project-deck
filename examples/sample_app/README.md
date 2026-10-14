# FlutterDeck sample app

A one-screen Flutter app for trying FlutterDeck by hand. It proves that a breakpoint set in your IDE still hits while the FlutterDeck daemon is attached to the app and reloading it. Later milestones add a Drift database to it and use it as the demo app.

The screen has:

- a line of text (`reloadMarker` in `lib/main.dart`) to edit and hot reload;
- a tap counter;
- a **Hit breakpoint** button. Each tap runs `onHitBreakpoint()` and writes three log lines: a `print`, a `developer.log` line named `flutterdeck.sample`, and an Android logcat line with the tag `FlutterDeckSample`.

## Open it in Android Studio

1. **File > Open**, then pick the `examples/sample_app` folder (not the repo root).
2. Pick an Android emulator or device in the device menu.
3. Press **Debug** (the bug icon).

## The breakpoint line

In `lib/main.dart`, find the line that ends with `// FLUTTERDECK: put the breakpoint on this line` (inside `onHitBreakpoint()`). Click in the gutter next to it to add a red dot. Tap **Hit breakpoint** in the app and Android Studio stops on that line.

## Use it with the daemon

Start the app from Android Studio first. Then, from the repo root:

```bash
pnpm build
node packages/daemon/dist/main.js
```

In a second terminal at the repo root:

```bash
node scripts/dtd-apps.mjs
```

It lists the running sample app. Attach and reload through the daemon's API (see the repo [README](../../README.md) for the token and port), edit `reloadMarker`, and check that the breakpoint still hits after each reload.
