# MCP database tools and init app ids: facts and differences from the plan

Batch 5 of [the M3 design](../design/m3-drift-inspector.md) (`feat/mcp-db-tools`): the MCP tools `db_list`, `db_schema`, `db_query`, `db_snapshot` and `db_diff`, `flutterdeck init` writing the app ids, and the sql-guard `written` hardening. Checked on 20 Oct 2026 against @modelcontextprotocol/sdk 1.32.1 (already pinned) and the daemon's `/api/db` routes on `main` (d17e423).

## Facts checked

- **The tools are thin clients.** Each one calls one `/api/db` route with the `runtime.json` token, so the daemon treats the caller as Claude (notes/db-backends.md item 9): hidden columns refused or dropped, 500 rows per query, 50 rows and 20 tables per diff, no CREATE text. The MCP server adds the 20 kB cap, masking and the notes for Claude on top.
- **No write path.** No tool calls `/api/db/execute`, `/execute/confirm`, `/execute/cancel`, `/device` or `/queries`, and those routes refuse the token anyway (dashboard cookie and Origin only). Tests check both the tool list and the requests.
- **Inputs** are validated with core's shared schemas (`DbListInput`, `DbSchemaInput`, `McpDbQueryInput` with its 500-row cap, `DbSnapshotInput`, `DbDiffInput`) before any request, and again by the daemon.
- **Masking runs before the cut**, as for `get_logs`. Masking only sees text, so integer cells go through it as text and come back as numbers when nothing was masked (a phone number stored as an integer is masked like one in text, design review S8). Blobs reach Claude only as `[BLOB n bytes]`; big integers and odd doubles as text.
- **Every description** contains core's `DB_UNTRUSTED_TEXT` word for word, says Claude cannot change data, and says masking is best effort. Successful answers carry `DB_UNTRUSTED_TEXT` as `note`; error texts say the message may quote the app's database.

## Differences from the plan and the design note

1. **Database calls wait up to 75 s**, not the 5 s of the other routes: a snapshot backend may copy the file from a device first (adb `ls` 10 s plus `cat` 60 s, design review S7). Queries are still stopped after 5 s by the backends.
2. **`db_list` leaves out `writesAllowed` and the device list** of a `choose-device` problem. Claude can't write and can't pick a device, so both would only invite it to try; the hint asks the user to pick in the dashboard.
3. **`db_schema` is compact:** columns show `pk`, `notNull` and `default` only when set. Past 20 kB whole tables are left out and named in `leftOutNames` (at most 200 names).
4. **`db_diff` past 20 kB** first lists fewer rows per table, then fewer tables; `counts` always stay the real totals and `truncated` says so.
5. **Errors are plain text**: `FlutterDeck couldn't do that (<code>): <daemon's reason>` plus a hint per code (`refused`, `unsupported`, `choose-device`, `busy`, `timeout`, `setup-needed`, `update-needed`, `not-debuggable`, `app-gone`, `not-found`).
6. **`db_snapshot` is marked read-only** (`readOnlyHint`): it stores hashes in the daemon's memory and changes nothing in the app.
7. **`init` and the Android id**: the Gradle file is read as text only. An id inside a block comment is ignored, and two different ids (flavors that set their own) give none, so snapshots fall back to the running app's id (notes/db-backends.md item 5). The id must match core's `ANDROID_APPLICATION_ID`, which config.json and db-sqlite use.
8. **`init` and the iOS id**: read from the Runner target's Debug configuration with a small linear parser for Xcode's property lists; details in [untrusted-project-files.md](untrusted-project-files.md). A build variable or anything else unusable prints a note asking the user to set `ios.bundleId`.
9. **sql-guard `written`**: the gate's verdict carries `written` (write mode only), and `requestEdit` refuses unless it holds exactly one table. The `FakeSqlGuard` default now passes a plain one-table edit in write mode the way the real gate does.
10. **For the lead:** the MCP tools table in PLAN.md (section "MCP tools") still lists `db_execute`; the M3 box and the PM decision of 16 Oct 2026 say there is none.
