# FlutterDeck early install guide (M3 preview)

> This page is built from `docs/marketing/m3-install-guide.md` in the repo, which is the source. Do not edit it here. See also [[Safety and privacy|Safety-and-privacy]], [[FAQ]] and [[Feedback]].

Draft for the M3 validation checkpoint (docs/PLAN.md). This guide installs FlutterDeck from a git checkout. Packages on npm and pub.dev come with a later release.

The steps are for **macOS with zsh**. They were not run on Windows or Linux for this guide.

## What it is

FlutterDeck is open source (MIT). It puts your Flutter app's Drift database next to Claude in Claude Desktop. You see the tables live in a Database tab in Claude Desktop's Browser pane, and Claude can read the database to answer questions about your data.

- **It attaches, it never launches.** You start your app from your IDE or `flutter run`, in debug mode, as usual. We tested with Android Studio and `flutter run`; VS Code is untested. FlutterDeck finds the running app and connects to it. Your IDE keeps control, so your breakpoints still work.
- **Debug builds only.** The in-app package, `flutterdeck_drift`, works only in debug builds. We checked that a profile build doesn't include it; we have not built a release build.
- **Claude can't change data through FlutterDeck.** FlutterDeck's database tools for Claude refuse every query that writes. You can hide columns from FlutterDeck's tools.
- It also gives Claude your app's logs, and works with the official Dart MCP server for hot reload and runtime errors.

## What it is not (yet)

- Not a published package. You build it from a git checkout.
- Not tested on Windows or Linux in this guide. QA tested on macOS with an Android emulator.
- iOS: tested on Android (emulator) and the iOS Simulator; real iPhones are untested (the PM's own check, 25 Oct 2026). QA's own iOS Simulator check covered only a read-only database copy (snapshot). We make no claim about iOS speed.
- The live view needs Drift. On Android, other SQLite databases can be read as a snapshot copy (not tested in an app without the package); see [Snapshot mode](#snapshot-mode-on-android-without-the-package).
- Not a cloud service. FlutterDeck runs on your computer and listens only on `127.0.0.1`. What Claude reads with FlutterDeck's tools goes into your Claude conversation, like any other tool result.

## Prerequisites

| What                              | Version we tested                             | Check with          |
| --------------------------------- | --------------------------------------------- | ------------------- |
| Node.js                           | 22.12 or later (tested 22.12.0)               | `node --version`    |
| pnpm                              | 10 (tested 10.34.5)                           | `pnpm --version`    |
| Flutter                           | tested 3.44.6, with Dart 3.12.2               | `flutter --version` |
| Dart                              | 3.12.2 or later (`flutterdeck_drift`)         | `dart --version`    |
| Android Studio (VS Code untested) | with the Flutter plugin                       |                     |
| An Android emulator or device     | tested on API 34; older versions are untested | `adb devices`       |
| `adb`                             | from the Android SDK, on your PATH            | `adb --version`     |
| Claude Desktop                    | with Claude Code sessions                     |                     |
| `claude` command                  | on your PATH                                  | `claude --version`  |
| git                               |                                               | `git --version`     |

The Dart MCP server needs Dart 3.9 or later. The `flutterdeck_drift` package (`dart/flutterdeck_drift/pubspec.yaml`) needs Dart `^3.12.2`, `drift: ^2.35.2`, `sqlite3: ^3.5.2` and `ffi: ^2.1.0`. Your app must resolve the same packages within these ranges.

## 1. Get FlutterDeck

These steps put the checkout in `$HOME/project-deck` (the folder `project-deck` in your home folder). If you use another folder, change `$HOME/project-deck` in every command.

1. Clone and build:

   ```bash
   git clone https://github.com/Thamzy265/project-deck.git "$HOME/project-deck" && cd "$HOME/project-deck" && pnpm install --frozen-lockfile && pnpm build
   ```

   Expected: it ends without errors.

2. Make a `flutterdeck` command for this terminal:

   ```bash
   alias flutterdeck="node $HOME/project-deck/packages/cli/dist/main.js"
   ```

   Expected: no output. `flutterdeck --help` now lists `init`, `start`, `stop`, `open` and `mcp`.

   The alias lasts until you close the terminal. To keep it, add it to your shell startup file:

   ```bash
   echo "alias flutterdeck=\"node $HOME/project-deck/packages/cli/dist/main.js\"" >> ~/.zshrc
   ```

## 2. Try it without a device (fake mode)

Fake mode runs FlutterDeck with a built-in fake app and a small database (`orders`, `customers`, `audit_log`). It needs no Flutter, device or IDE. It takes about 5 minutes.

Run every step of this section in the same terminal: the steps share the variables `T` and `DECK_PID`.

The commands set `HOME` to a scratch folder. FlutterDeck keeps a list of project ports in `~/.flutterdeck/`. The scratch `HOME` keeps this throwaway project out of that list, and the clean-up step removes everything. The FlutterDeck MCP server must use the same `HOME` as the daemon, so the commands set it for both.

1. Make a scratch folder. Hide the `customers.email` column from Claude:

   ```bash
   cd "$HOME/project-deck" && T=$(mktemp -d) && mkdir -p "$T/home" "$T/proj/.flutterdeck" && echo '{"version":1,"db":{"hiddenColumns":["customers.email"]}}' > "$T/proj/.flutterdeck/config.json"
   ```

   Expected: no output.

2. Start FlutterDeck in fake mode:

   ```bash
   HOME="$T/home" USERPROFILE="$T/home" node packages/daemon/dist/main.js --fake --project "$T/proj" --port 0 & DECK_PID=$!
   ```

   Expected: `project-deck daemon listening on http://127.0.0.1:<port>`. Press Enter to get the prompt back. The fake app adds an order every 5 seconds.

3. Print the dashboard address:

   ```bash
   node -p "'http://127.0.0.1:' + require('$T/proj/.flutterdeck/runtime.json').port + '/'"
   ```

   Expected: `http://127.0.0.1:<port>/`.

4. Within 2 minutes of step 2, open that address in Claude Desktop's Browser pane: ask Claude in any Code session to open it in the Browser pane, or paste it into the pane's address bar.

   Expected: the **Database** tab, with "app · Live". The 2-minute limit is the login window: the dashboard logs in only while it is open. If you see "Login needed", run this, then reload the pane:

   ```bash
   HOME="$T/home" USERPROFILE="$T/home" node packages/cli/dist/main.js open --project "$T/proj"
   ```

   Expected: `Dashboard: http://127.0.0.1:<port>/` and "Open it within 2 minutes to log in". The token stays in the file; you never see or copy it.

5. Choose the table **orders**. In **Sort by**, choose **id ▼**.

   Expected: every 5 seconds a new "Order N" row appears at the top, tinted for a moment.

6. Click **SQL**. Type `SELECT count(*) FROM orders WHERE status = 'pending'` and press Cmd+Enter.

   Expected: "1 row in N ms" and a number.

7. Optional: ask Claude about the fake database. Write a project MCP file for Claude, and print the folder:

   ```bash
   printf '{"mcpServers":{"flutterdeck-try":{"command":"node","args":["%s/packages/mcp/dist/main.js","--project","%s"],"env":{"HOME":"%s"}}}}\n' "$PWD" "$T/proj" "$T/home" > "$T/proj/.mcp.json"; echo "$T/proj"
   ```

   Expected: a folder path such as `/var/folders/…/proj`. In Claude Desktop, start a new Code session in that folder. Allow the project's MCP server `flutterdeck-try`, and allow the `db_…` tools when Claude asks. Then ask:
   - `How many orders are pending?` — Claude gives a number.
   - `Take a database snapshot, wait 10 seconds, then use db_diff to tell me what changed.` — Claude lists about two new "Order N" rows.
   - `Show me every customer's email` — refused: the column is hidden.
   - `Delete all orders` — Claude says FlutterDeck's tools can't change data. If Claude asks to run a command or edit a file instead, choose No.

8. Clean up. Close the Claude session and the Browser pane tab. Then:

   ```bash
   kill "$DECK_PID"; rm -rf "${T:?run this in the terminal from step 1}"
   ```

   Expected: the shell may print that the job was terminated. If `kill` says "no such process", run:

   ```bash
   pkill -f "${T:?run this in the terminal from step 1}/proj"; rm -rf "${T:?}"
   ```

   If it says "T: run this in the terminal from step 1", you are in another terminal: go back to the terminal of step 1.

## 3. First run with the sample app

The checkout has a small Drift app, `examples/sample_app`, with an `orders` table and two buttons: **Add order** and **Hit breakpoint**. It is the quickest way to see the real thing. About 20 minutes. Run the terminal steps in one terminal, from `$HOME/project-deck`.

1. Make the sample app a FlutterDeck project:

   ```bash
   cd "$HOME/project-deck" && flutterdeck init --project examples/sample_app
   ```

   Expected: dart, flutter and adb show as found. Under "Changes": `created .flutterdeck/config.json`, `updated .gitignore` and `created .claude/launch.json`. The port can be another number than 9147.

2. Give Claude the FlutterDeck plugin. It loads from your checkout, in place:

   ```bash
   claude plugin marketplace add "$HOME/project-deck" && claude plugin install flutterdeck@flutterdeck-dev
   ```

   Expected: a success message that names `flutterdeck-dev`, then one that says `flutterdeck` is installed. If the marketplace already exists, run only `claude plugin install flutterdeck@flutterdeck-dev`. Then quit Claude Desktop (Cmd+Q) and open it again.

   The plugin gives Claude two MCP servers: the official Dart MCP server (hot reload, runtime errors) and FlutterDeck's own (logs and the database tools). It also adds hooks that show Claude's activity in the dashboard.

3. In Android Studio choose **File > Open** and pick `project-deck/examples/sample_app` in your home folder (not the repo root). Start an emulator. In `lib/main.dart`, set a breakpoint on the line that ends with `// FLUTTERDECK: put the breakpoint on this line`. Press **Debug**, not Run. (VS Code is untested: open the same folder and choose **Run > Start Debugging**.)

   Expected: the app opens on the emulator with **Hit breakpoint**, **Add order** and a red DEBUG banner.

4. Start FlutterDeck:

   ```bash
   flutterdeck start --project examples/sample_app
   ```

   Expected: "FlutterDeck started." and the dashboard address. Do step 5 within 2 minutes.

5. In Claude Desktop, start a new Code session with `project-deck/examples/sample_app` in your home folder as its project folder. Open the Browser pane and choose **FlutterDeck**.

   Expected: the dashboard opens with the **Database** tab and the `sample` database. If it says "Login needed", run `flutterdeck open --project examples/sample_app` and reload the pane.

6. Type `/mcp` in the chat.

   Expected: the servers `dart` and `flutterdeck` of the `flutterdeck` plugin are connected.

7. In the Database tab choose **orders**, and in **Sort by** choose **id ▼**. Tap **Add order** in the app.

   Expected: a new row appears at the top of the grid and is tinted for a moment.

8. Ask Claude: `How many orders are pending in the FlutterDeck database sample?` Approve the tool if Claude asks.

   Expected: a number that matches the `pending` rows in the grid.

9. Tap **Hit breakpoint** in the app.

   Expected: the IDE stops on the marked line. Press **Resume**. The app keeps working.

Clean up the sample app when you are done. First close the Claude Code session in `sample_app`: the plugin's FlutterDeck MCP server starts FlutterDeck again while a session runs in that folder. Then:

```bash
cd "$HOME/project-deck" && flutterdeck stop --project examples/sample_app && git restore examples/sample_app/.gitignore && rm -rf examples/sample_app/.flutterdeck examples/sample_app/.claude && git status --short
```

Expected: "FlutterDeck stopped.", then nothing from `git status`. Stop the app in the IDE. Keep the plugin for your own app, or remove it as in [Remove FlutterDeck](#remove-flutterdeck).

## 4. Use it with your own app

Your app must use Drift and run in debug mode. Below, `~/code/my_app` stands for your app's folder; change it in every command.

1. Add `flutterdeck_drift` to your app's `pubspec.yaml`, under `dependencies`, as a path to your checkout. Print the path to use:

   ```bash
   echo "$HOME/project-deck/dart/flutterdeck_drift"
   ```

   Then add these lines, with that path:

   ```yaml
   dependencies:
     flutterdeck_drift:
       path: /Users/you/project-deck/dart/flutterdeck_drift
   ```

   Don't commit this change: the path is for your machine only. It is a normal dependency, not a dev dependency, because `main.dart` imports it. It works only in debug builds (a profile build was checked; release was not built).

2. Get the package:

   ```bash
   cd ~/code/my_app && flutter pub get
   ```

   Expected: "Got dependencies!" or "Changed N dependencies!". If pub can't resolve versions, check your app against the four constraints in [Prerequisites](#prerequisites): Dart `^3.12.2`, `drift: ^2.35.2`, `sqlite3: ^3.5.2` and `ffi: ^2.1.0`.

3. Register your database in `main()`, after you create it:

   ```dart
   import 'package:flutterdeck_drift/flutterdeck_drift.dart';

   void main() {
     final db = AppDatabase();
     FlutterDeckDrift.register(db, name: 'app');
     runApp(MyApp(database: db));
   }
   ```

   `name` is the name you see in the Database tab and the name Claude uses. Register each database once, with its own name.

4. Set up FlutterDeck in your app's folder:

   ```bash
   cd ~/code/my_app && flutterdeck init
   ```

   Expected: under "Changes": `.flutterdeck/config.json`, `.gitignore` and `.claude/launch.json`. The `.gitignore` block covers the files that hold the session token. `config.json` and `launch.json` are not ignored: commit them if your team wants the same settings, or add them to `.gitignore`.

5. Optional: hide columns from Claude, for example personal data of your users. Use `table.column`:

   ```bash
   node -e "const fs=require('fs'),f='.flutterdeck/config.json',c=JSON.parse(fs.readFileSync(f,'utf8'));c.db={...c.db,hiddenColumns:['users.email']};fs.writeFileSync(f,JSON.stringify(c,null,2)+'\n')"
   ```

   Change `users.email` to your own columns. Do this before `flutterdeck start`, or run `flutterdeck stop` and `flutterdeck start` after it.

6. Install the plugin as in [section 3, step 2](#3-first-run-with-the-sample-app), if you haven't.

7. Start your app from your IDE in **debug** mode.

8. Start FlutterDeck, then open it within 2 minutes:

   ```bash
   cd ~/code/my_app && flutterdeck start
   ```

   In Claude Desktop, start a new Code session in your app's folder. Open the Browser pane and choose **FlutterDeck**.

   Expected: the Database tab shows your database by the name you registered, with "Live".

### Snapshot mode on Android (without the package)

If you don't add `flutterdeck_drift`, FlutterDeck can still read a copy of your app's SQLite files on Android. This was not tested in an app without the package. It copies the files from a debug build of your app with `adb`, and reads the copy. `flutterdeck init` writes your app's Android id into `config.json` for this. In the Database tab these databases say "Snapshot". A snapshot is read-only, and it shows the data from the moment of the copy.

## First questions to ask Claude

Start a Code session in your app's folder, with the plugin installed and FlutterDeck running. Add "Use FlutterDeck" if Claude reaches for other tools.

- `Which databases and tables does FlutterDeck see?`
- `How many orders are pending?` (use your own table)
- `Take a database snapshot. ` Then do something in your app. Then: `Use db_diff with that snapshot: what did my change save?`
- `Show the last 20 log lines from the app.`

## How your data is protected

- FlutterDeck's database tools for Claude only read: FlutterDeck checks every query with the real SQLite engine before it runs, and refuses anything that changes data. Hidden columns (`db.hiddenColumns`) are refused in every query of these tools and left out of their diffs.
- Rows and log lines are untrusted data: Claude's tools tell it not to follow instructions found in them. The dashboard and its API answer only on `127.0.0.1`, and need the session token in `.flutterdeck/runtime.json`.

Known limit: these rules cover FlutterDeck's tools only. Claude Code's other tools can still reach your database: a shell command (for example `adb` or `sqlite3`), a file read, or the Browser pane, where Claude can read what the dashboard page shows, as you can. If you turn on `db.allowWrites`, Claude driving the Browser pane could also click Edit in the Database tab. Keep Claude Code's permission prompts on, and choose No when Claude asks to run a command or read a file that touches your app's data.

## Remove FlutterDeck

Run each step that applies.

The plugin is installed for your user, so it runs in every Claude Code session. Its FlutterDeck MCP server starts FlutterDeck in any project folder that has `.flutterdeck/config.json`. So close every Claude Code session in those projects before you stop FlutterDeck, or it starts again.

1. Close the Claude Code sessions in your FlutterDeck projects. Then stop FlutterDeck in each project where you started it:

   ```bash
   cd ~/code/my_app && flutterdeck stop
   ```

   Expected: "FlutterDeck stopped." or "FlutterDeck isn't running for this project."

2. Remove the plugin and the development marketplace:

   ```bash
   claude plugin uninstall flutterdeck@flutterdeck-dev && claude plugin marketplace remove flutterdeck-dev
   ```

   Expected: both succeed. Quit Claude Desktop (Cmd+Q) and open it again.

3. In your app's folder, remove FlutterDeck's folder:

   ```bash
   cd ~/code/my_app && rm -rf .flutterdeck
   ```

   Then open `.gitignore` in an editor and delete the block from the line that starts with `# >>> flutterdeck` to the line `# <<< flutterdeck`, both included. `init` also added a blank line just before the block: delete it too. Check that only that block went:

   ```bash
   git diff .gitignore
   ```

   Expected: no output if you never committed the block. If you committed it, only the removed blank line and block lines (with `-`), nothing else.

4. Remove the "FlutterDeck" entry from `.claude/launch.json`. If it is the only entry, delete the file:

   ```bash
   cat .claude/launch.json
   ```

   If you see only the "FlutterDeck" configuration, run `rm .claude/launch.json`. Otherwise, delete that one entry in your editor.

   If you chose "don't ask again" for FlutterDeck's tools, Claude Code saved that in `.claude/settings.local.json`. Open it and delete the entries under `permissions` that name `flutterdeck` (for example `mcp__plugin_flutterdeck_flutterdeck__db_query`). If nothing else is left in the file, delete the file.

5. Remove `flutterdeck_drift` from `pubspec.yaml`, and the `import` and `FlutterDeckDrift.register(...)` lines from `main.dart`. Then:

   ```bash
   flutter pub get
   ```

6. Remove FlutterDeck's per-user port list and the checkout:

   ```bash
   rm -rf "$HOME/.flutterdeck" "$HOME/project-deck"
   ```

7. Remove the alias from this terminal:

   ```bash
   unalias flutterdeck
   ```

   If you added it to `~/.zshrc`, also delete the line that starts with `alias flutterdeck=` in that file.

## More

- [[Try it without a device|Try-without-a-device]]
- [[Safety and privacy|Safety-and-privacy]]
- [[FAQ]]
- [[Feedback]]
