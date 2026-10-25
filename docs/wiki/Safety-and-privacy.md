# Safety and privacy

These rules cover **FlutterDeck's own tools**. They do not cover everything Claude Code can do.

## What FlutterDeck does

- FlutterDeck's database tools for Claude only read. FlutterDeck checks every query with the real SQLite engine before it runs, and refuses anything that changes data. Hidden columns (`db.hiddenColumns` in `.flutterdeck/config.json`) are refused in every query of these tools and left out of their diffs.
- Rows and log lines are untrusted data: Claude's tools tell it not to follow instructions found in them.
- The dashboard and its API answer only on `127.0.0.1`, and need the session token in `.flutterdeck/runtime.json`. You never copy the token: `flutterdeck open` lets the dashboard log in.
- The in-app package, `flutterdeck_drift`, works only in debug builds. A profile build was checked and does not include it. A release build has not been built.
- FlutterDeck attaches to your running app. It never launches or stops it.

## Known limit

These rules cover FlutterDeck's tools only. Claude Code's other tools can still reach your database: a shell command (for example `adb` or `sqlite3`), a file read, or the Browser pane, where Claude can read what the dashboard page shows, as you can. If you turn on `db.allowWrites`, Claude driving the Browser pane could also click Edit in the Database tab. Keep Claude Code's permission prompts on, and choose No when Claude asks to run a command or read a file that touches your app's data.

## Where your data goes

- FlutterDeck runs on your computer. It is not a cloud service and it has no account.
- What Claude reads with FlutterDeck's tools (rows, schema, log lines) goes into your Claude conversation, like any other tool result. Use `db.hiddenColumns` for columns with personal data of your users.
- `~/.flutterdeck` holds only a per-user list of project ports. The session token stays in `.flutterdeck/runtime.json` in your project, which the `.gitignore` block that `init` adds covers.
- Snapshots are read-only copies, and show the data from the moment of the copy.

## Feedback is public

Feedback goes to a public GitHub Discussions thread. Do not paste app data, database rows, logs, tokens, addresses or personal data there. See [[Feedback]].

Back to [[Home]].
