# M3 demo — 60-second script and shot list

> **Name.** The PM keeps "FlutterDeck" for the validation post (PM decision, 2026-10-25). The name stays an open decision before M5 (docs/PLAN.md, "Open decisions").

Draft for the M3 validation checkpoint (docs/PLAN.md). The team drafts; the PM records, publishes and collects feedback. Nothing here is posted.

The demo shows the real sample app (`examples/sample_app`) on an Android emulator, started from Android Studio in Debug, with FlutterDeck attached. Claude Desktop shows the chat and the FlutterDeck Database tab in the Browser pane.

## What the viewer must take away

1. FlutterDeck attaches to an app you already run from your IDE. Your breakpoints still work.
2. You see your Drift database live, next to Claude.
3. Claude can read the database to answer questions and to check what a change saved. Claude can't change data through FlutterDeck: its database tools refuse every query that writes. Columns you hide are hidden from FlutterDeck's tools.

## Before recording: setup checklist

These steps come from the tested PM checks in [docs/qa/M3.md](../qa/M3.md) ("PM check (IDE breakpoint)" and "PM check (batch 5)"). Run them from the repo root of the main checkout, in one terminal. Do them **before** you start the screen recorder, because the terminal shows the dashboard address and some commands read the token.

- [ ] 1. Build the latest `main`:

  ```bash
  cd ~/Developer/Personal/project-deck && git switch main && git pull && pnpm install --frozen-lockfile && pnpm build
  ```

  Expected: it ends without errors.

- [ ] 2. Make the sample app a FlutterDeck project:

  ```bash
  node packages/cli/dist/main.js init --project examples/sample_app
  ```

  Expected: dart, flutter and adb show as found. Under "Changes": `created .flutterdeck/config.json`, `updated .gitignore`, `created .claude/launch.json`.

- [ ] 3. Hide one column from Claude. The sample has no personal data, so `orders.created_at` stands in for a column such as `customers.email`:

  ```bash
  node -e "const fs=require('fs'),f='examples/sample_app/.flutterdeck/config.json',c=JSON.parse(fs.readFileSync(f,'utf8'));c.db={...c.db,hiddenColumns:['orders.created_at']};fs.writeFileSync(f,JSON.stringify(c,null,2)+'\n')" && grep -A3 '"db"' examples/sample_app/.flutterdeck/config.json
  ```

  Expected: the `db` block lists `"orders.created_at"` under `hiddenColumns`. Do this before step 6: FlutterDeck reads the setting when it starts. If FlutterDeck already runs, run `node packages/cli/dist/main.js stop --project examples/sample_app`, then step 6 again.

- [ ] 4. Give Claude the FlutterDeck plugin:

  ```bash
  claude plugin marketplace add "$(pwd)" && claude plugin install flutterdeck@flutterdeck-dev
  ```

  Expected: a success message that names `flutterdeck-dev`, then one that says `flutterdeck` is installed. If the marketplace already exists, run only the `install` part. Quit Claude Desktop (Cmd+Q) and open it again.

- [ ] 5. If the sample app is already on the emulator from an earlier check, clear its data first, so the counts below are right: on the emulator, long-press the app icon, then **App info > Storage & cache > Clear storage**. Then, in Android Studio, open `examples/sample_app` (not the repo root). Start the emulator. In `lib/main.dart`, set a breakpoint on the line `taps.value += 1; // FLUTTERDECK: put the breakpoint on this line` (about line 18). Press **Debug** (the bug icon), not Run.

  Expected: the app shows **Hit breakpoint**, **Add order** and a red DEBUG banner. The red dot is solid.

- [ ] 6. Start FlutterDeck:

  ```bash
  node packages/cli/dist/main.js start --project examples/sample_app
  ```

  Expected: "FlutterDeck started." and the dashboard address. The login window is open for 2 minutes, so do step 7 now.

- [ ] 7. In Claude Desktop, start a new Code session with `examples/sample_app` as its project folder. Open the Browser pane and choose **FlutterDeck**.

  Expected: the dashboard opens with the **Database** tab. If it says "Login needed", run `node packages/cli/dist/main.js open --project examples/sample_app` in the terminal and reload the pane.

- [ ] 8. Type `/mcp` in the chat.

  Expected: the servers `dart` and `flutterdeck` of the `flutterdeck` plugin are connected. Then clear the chat or start a fresh session in the same folder, so the recording starts with an empty chat.

- [ ] 9. Give the app some data. Tap **Add order** 6 times. Tap the status of two orders once each, so they become `shipped`.

  Expected: 6 orders in the app, 4 of them `pending`. If the app still had orders, the counts are higher: what matters is that the grid and Claude agree.

- [ ] 10. In the Database tab, choose the table **orders**. In **Sort by**, choose **id ▼** so new rows appear at the top.

  Expected: the newest order is at the top.

- [ ] 11. Allow the FlutterDeck `db_…` tools ahead of time, so no approval prompt interrupts a shot: ask Claude `List the FlutterDeck databases.`, then `How many orders are there?`, then `Take a FlutterDeck database snapshot.` Each time Claude asks, choose the option that allows the tool without asking again in this project. Then start a fresh session in the same folder. If an approval prompt still shows during a shot, approve it and cut the wait.

- [ ] 12. Close the terminal window or move it off the recorded screen.

## Recording tips

- **Window layout.** Left half: Android Studio with the emulator window docked beside the editor. Right half: Claude Desktop with the chat and the Browser pane. Keep the Browser pane about 420 px wide (the dashboard works at that width; QA checked 420 px in [docs/qa/M3.md](../qa/M3.md), batch 4, B row S).
- **Resolution.** Record at 1920 × 1080. Use macOS screen recording (Cmd+Shift+5, "Record Selected Portion") or your usual tool.
- **Font size.** Zoom Claude Desktop once or twice (Cmd+=). In Android Studio, set the editor font to 16 pt or more (Settings → Editor → Font).
- **Light or dark.** Pick one and keep it for every scene. The dashboard follows the system setting; QA checked both (batch 4, B row S). Light reads better in a small video.
- **Never on screen:**
  - the terminal output of `start` or `open`, and any command that reads `.flutterdeck/runtime.json` (it holds the token);
  - Android Studio's Run or Debug console text. It prints the VM service and DevTools addresses, which carry an auth code. Collapse the bottom tool window, or switch it to the **Debugger** tab (frames and variables only) before you record;
  - Claude's tool-call details for any **Dart** MCP server tool (`dtd`, `hot_reload` …): their inputs can hold a DTD or VM service URI. The script only uses FlutterDeck's `db_…` tools. If Claude calls a Dart tool, stop and record the shot again;
  - your own projects, file names or notifications. Turn on Do Not Disturb.
- **Prompts.** Type each prompt before you start the shot and paste it, or type it slowly. Cut the wait while Claude thinks.
- **Tool calls.** Leave Claude's tool-call rows collapsed. Expand one only where the shot list says so.

## Shot list

Times are the final edit. Recording takes longer: cut the waits.

| #   | Time      | On screen                                                                               | What the PM does or types (exactly)                                                                                                                                                 | Narration / caption                                                                                                                                                      | Must be visible for the shot to count                                                                                                                                                                                                                                             |
| --- | --------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 0:00–0:05 | Full layout: Android Studio + emulator left, Claude Desktop with the Database tab right | Nothing. Hold the shot.                                                                                                                                                             | "Your Flutter app, running from your IDE. Its Drift database, live, next to Claude."                                                                                     | The red DEBUG banner in the app; the Database tab on `orders` with the "Live" badge.                                                                                                                                                                                              |
| 2   | 0:05–0:15 | Emulator and the Database tab                                                           | Tap **Add order** in the app. Wait 2 s. Tap it again.                                                                                                                               | "Add an order in the app. The new row shows up and flashes in the table."                                                                                                | Each tap adds a new top row in the grid with the tint. The new order is also in the app's list.                                                                                                                                                                                   |
| 3   | 0:15–0:25 | Claude chat and the Database tab                                                        | Type: `How many orders are pending in the FlutterDeck database sample?`                                                                                                             | "Ask Claude about the data. It reads the database with a read-only query."                                                                                               | Claude's answer with a number that matches the `pending` rows in the grid (two more than before shot 2; 6 on the setup above). The collapsed `db_query` tool row.                                                                                                                 |
| 4   | 0:25–0:38 | Claude chat, then the emulator, then Claude chat                                        | Type: `Take a FlutterDeck database snapshot of the sample database.` Then tap **Add order** twice in the app. Then type: `Use db_diff with that snapshot and tell me what changed.` | "Did the change save? Claude takes a snapshot, you add two orders, and Claude compares."                                                                                 | The `db_snapshot` and `db_diff` tool rows. Claude's answer names two added rows with their items and `pending`. Cut the time between the prompts.                                                                                                                                 |
| 5   | 0:38–0:46 | Claude chat                                                                             | Type: `Delete all orders.` Then type: `When was each order created?`                                                                                                                | "Through FlutterDeck, Claude only reads. Columns you hide stay hidden from FlutterDeck's tools."                                                                         | For the delete: Claude says FlutterDeck's tools can't change data (no rows go away in the grid). If Claude asks to run a command or edit code, choose No and record the shot again. For the second: Claude says `created_at` is hidden. Show the refusal text; collapse the rest. |
| 6   | 0:46–0:56 | Android Studio editor and emulator, then the Database tab                               | Tap **Hit breakpoint** in the app. Android Studio stops on the marked line. Click **Resume** (the green play button in the Debugger tab). Tap **Add order**.                        | "FlutterDeck attaches. It never launches your app, so your debugger keeps working."                                                                                      | The editor stopped on `taps.value += 1;` with the execution line highlighted. After Resume, the Taps counter goes up and a new row flashes in the Database tab.                                                                                                                   |
| 7   | 0:56–1:00 | End card                                                                                | Nothing (made in the editor).                                                                                                                                                       | "FlutterDeck. Early preview, open source (MIT), tested on Android and the iOS Simulator. Try it from the repo and tell us what you think. [REPO LINK] · [FEEDBACK LINK]" | The two links.                                                                                                                                                                                                                                                                    |

Keep the narration as captions, or record it as a voice-over after the cut. The caption text above is about 120 words, which fits 60 seconds at a calm pace.

## Recording order

Record in this order. Each item is a separate clip; cut them together in shot order.

1. **Clip A — shots 2, 3, 4 and 5**, one take, in one Claude session. This keeps the counts consistent: the pending count in shot 3 includes the two orders from shot 2.
2. **Clip B — shot 6**, separately. Make sure the breakpoint is still set and the Debugger tab is the visible bottom tool window. If Android Studio does not stop after a hot reload, that is the known upstream Flutter limitation (PM decision, 14 Oct 2026): remove the red dot, set it again, and tap again.
3. **Clip C — shot 1**: 5 seconds of the full layout with no action. Record it last, when the grid has many rows.
4. **Shot 7** is a title card made in the video editor.

Shots 2–5 can also be recorded as four clips, if one take is too long. Then repeat the "Sort by id ▼" check before each clip, and make sure the shot 3 number still matches the grid.

## Clean-up after recording

Run these from the repo root of the main checkout, one at a time. They come from "PM check (IDE breakpoint)", step 10.

1. Stop the app in Android Studio (the red square). Close the Browser pane tab. Quit the emulator if you started it only for this.
2. Stop FlutterDeck:

   ```bash
   node packages/cli/dist/main.js stop --project examples/sample_app
   ```

   Expected: "FlutterDeck stopped."

3. Remove the files `init` made, and the hidden-column setting with them:

   ```bash
   git restore examples/sample_app/.gitignore && rm -rf examples/sample_app/.flutterdeck examples/sample_app/.claude && git status --short
   ```

   Expected: `git status --short` prints nothing.

4. Remove the plugin, if you don't keep it:

   ```bash
   claude plugin uninstall flutterdeck@flutterdeck-dev && claude plugin marketplace remove flutterdeck-dev
   ```

   Expected: both succeed. Quit Claude Desktop (Cmd+Q) and open it again.

5. Optional: the sample app stays installed on the emulator with its orders. Uninstall it from the emulator's app list if you want a clean emulator.

## Open questions for the PM

1. Captions only, or a voice-over? Who records the voice?
2. Where is the video hosted (YouTube, a GIF in the README, native video on LinkedIn)? This sets the [DEMO LINK]. The PM said they might post on LinkedIn.
3. Hidden column: `orders.created_at` is a stand-in. Do you prefer `orders.item`, which QA used on a real device (batch 3 and 4), at the cost of Claude's diff showing no item names?
4. Show the iOS Simulator in the demo? The PM checked it on 25 Oct 2026, but this script stays on Android.
5. Show the dashboard's own edit (with `db.allowWrites`)? It is not in this script, to keep the "Claude can't change data through FlutterDeck" message simple.

## Claims in this draft

| #   | Claim (as written)                                                                                                                                 | Evidence (docs/qa/... section, or "none")                                                                                                                | QA verdict                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | FlutterDeck attaches to an app you run from your IDE                                                                                               | qa/M3.md "IDE breakpoint check", step 4 and "PM run (2026-10-24)"                                                                                        | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 2   | It never launches your app                                                                                                                         | qa/M3.md "IDE breakpoint check" step 4 ("with no attach command"); qa/M1.md acceptance                                                                   | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 3   | Your debugger keeps working / breakpoints still hit while attached                                                                                 | qa/M3.md "IDE breakpoint check", "PM run (2026-10-24)"; batch 4 D; batch 5 F                                                                             | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 4   | The new row shows up and flashes in the table (shown, no time claimed)                                                                             | qa/M3.md batch 4 C, R2 (215–285 ms on a real Android app)                                                                                                | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 5   | The Drift database is shown live                                                                                                                   | qa/M3.md batch 4 C (live Drift), PM check (batch 4)                                                                                                      | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 6   | Claude answers "how many orders are pending?" with a read-only query                                                                               | qa/M3.md "M3 acceptance" (PM, 2026-10-23, fake mode); "PM run (2026-10-24)" step 7 on the real sample app                                                | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 7   | Claude checks what a change saved with `db_snapshot` and `db_diff`                                                                                 | qa/M3.md "M3 acceptance" (PM, fake mode); batch 5 D3 (real Android, MCP tools without Claude). Real app + real Claude together: none                     | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 8   | Through FlutterDeck, Claude only reads; its database tools refuse every query that writes                                                          | qa/M3.md "M3 acceptance" step 12 (PM); batch 5 B3, D4                                                                                                    | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 9   | Columns you hide are hidden from FlutterDeck's tools                                                                                               | qa/M3.md batch 5 B2 (`customers.email`, fake), batch 4 C R3 and batch 3 E2 (`orders.item`, device). `orders.created_at` itself: none                     | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 10  | Early preview, open source (MIT), tested on Android (emulator) and the iOS Simulator; real iPhones are untested                                    | Android: qa/M3.md batches 2–5 and "IDE breakpoint check" (emulator API 34). iOS: docs/qa/M3.md, PM report: iOS Simulator (2026-10-25). MIT: LICENSE file | verified — docs/qa/M3.md#readme-and-wiki-2026-10-25    |
| 11  | The dashboard works at about 420 px wide, light and dark                                                                                           | qa/M3.md batch 4 B, row S                                                                                                                                | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 12  | `hiddenColumns` is read when FlutterDeck starts (set it before `start`)                                                                            | none (the daemon reads config at start; not checked separately). Setting it before `start` is safe either way                                            | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 13  | The read-only and hidden-column rules cover FlutterDeck's tools only; Claude Code's shell, file and Browser pane tools are not covered (choose No) | docs/status.md, risks accepted by the PM 2026-10-16 (Bash) and 2026-10-17 (Browser pane); not a qa claim                                                 | verified — docs/qa/M3.md#claim-check-validation-drafts |
