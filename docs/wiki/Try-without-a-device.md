# Try FlutterDeck without a device

> This page is built from `docs/marketing/m3-install-guide.md` in the repo, which is the source. Do not edit it here. You first need step 1 of the [[Install guide|Install-guide]]: clone and build into `$HOME/project-deck`.

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

## More

- [[Install guide|Install-guide]]
- [[Safety and privacy|Safety-and-privacy]]
- [[Feedback]]
