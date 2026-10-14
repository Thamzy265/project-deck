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

It lists the running sample app.

Then run these commands in the second terminal, at the repo root.

1. Load the session token and port:

   ```bash
   TOKEN=$(node -p "require('./.flutterdeck/runtime.json').token")
   PORT=$(node -p "require('./.flutterdeck/runtime.json').port")
   ```

   Expected: no output.

2. List the apps the daemon can see:

   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/apps" | node -e "for (const a of JSON.parse(require('fs').readFileSync(0, 'utf8'))) console.log(a.id, a.device.platform, a.name)"
   ```

   Expected: one line per app, with its id, `android` and its name.

3. Keep the id of the first Android app:

   ```bash
   APP_ID=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/apps" | node -e "const a = JSON.parse(require('fs').readFileSync(0, 'utf8')).find((x) => x.device.platform === 'android'); console.log(a ? a.id : '')")
   echo "$APP_ID"
   ```

   Expected: the same id as in step 2. If it is empty, the daemon sees no Android app yet.

4. Attach to it:

   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/apps/$APP_ID/attach"
   ```

   Expected: the app as JSON, with the same `id`.

5. Edit `reloadMarker` in `lib/main.dart`, save, then reload through the daemon:

   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/reload"
   ```

   Expected: `{"ok":true,"kind":"hot-reload",...}`, and the new text on screen.

6. Tap **Hit breakpoint**. Android Studio stops on the marked line. Resume, then read the latest logs:

   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/logs?limit=10"
   ```

   Expected: `{"entries":[...],"truncated":...}` with the `Tap N` lines from the taps.

The full acceptance steps are in the [M1 PM check](../../docs/qa/M1.md#pm-check).
