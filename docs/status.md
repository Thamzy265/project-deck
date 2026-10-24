# Team status log

Kept by the lead (`/my-tech-team:lead` skill). Newest entry first. Each entry records what changed, open findings and blockers, so PM updates can say what changed "since last update".

## 2026-10-24 — M3 IDE breakpoint check passed

- Changed: QA wrote and ran a complete PM check for the IDE breakpoint (Android Studio on an emulator), using stand-ins for Android Studio and Claude Desktop. All 6 steps QA could run passed. The PM then ran all 10 steps on 2026-10-24: Android Studio stopped on the marked line with FlutterDeck attached, and Claude's pending count rose after Resume. The `flutterdeck_drift` box is ticked, so every M3 build box and the acceptance box are now ticked. Evidence in [qa/M3.md](qa/M3.md), "IDE breakpoint check".
- Deleted (standing approval): QA's worktree `agent-a3d85cce79078bbd0` and its branches `docs/m3-breakpoint-pm-check` (commit moved to the PR branch) and `worktree-agent-a3d85cce79078bbd0`, after copying `qa-artifacts/M3-breakpoint/` to the main checkout; local and remote branch `docs/m3-acceptance-part-two` after PR #41 merged. Local and remote branch `docs/m3-breakpoint-pm-check` after PR #42 merged.
- Host note: QA left its scratch HOME at `/private/tmp/claude-501/qa-m3bp/home` (outside the project). A `dartvm` process running since 20 Oct is not the team's and was left alone.
- Next: the M3 validation checkpoint. The team drafts a 60-second demo, an early install guide and the post text; the PM publishes them and collects feedback.
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none · PM: merge this record's PR.

## 2026-10-23 — M3 acceptance passed

- Changed: the PM ran "PM check (batch 5)" in Claude Desktop against the fake-mode daemon. Claude answered "how many orders are pending?", confirmed new rows with `db_snapshot` and `db_diff`, was refused the hidden `customers.email`, and could not delete. With the batch 4 row flash (285 ms), the M3 acceptance box is ticked. Step 1 of the PM check now starts from `main`, because the batch 5 worktree no longer exists.
- Deleted (standing approval): local and remote branch `docs/log-flake-fix-merge` after PR #40 merged.
- Next: the M3 validation checkpoint drafts (60-second demo, early install guide, post text) after the IDE breakpoint check.
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none · PM: IDE breakpoint check (batch 2 box, `flutterdeck_drift`).

## 2026-10-22 — MCP daemon restart flake fixed

- Merged (PM, 2026-10-22): PR #39 `fix/mcp-daemon-restart-flake` after reviewer approval and CI green on all nine checks. QA not run: the change is in tests only, with nothing to check on the running product. The lead's merge was blocked by the app's auto mode, so the PM merged. Deleted after merge (standing approval): local and remote branch `fix/mcp-daemon-restart-flake`.
- Changed: "starts it once more when it stops again right after starting" failed once on windows-latest, Node 24 (PR #37). Cause: a test timing assumption, not a race in the client. The client gave up after the tests' 0.3 s ready window. On Windows a new `runtime.json` can land later, because the rename is refused while a reader has the old file open and core retries with back-off. Tests that expect a daemon now wait 3 s (below Vitest's 5 s timeout); tests where none comes up keep 0.3 s. A new test refuses the second daemon's rename six times and fails every run under the old window. Reviewer R1 (retry budget, hidden write error) and R2 (window equal to the test timeout) fixed; cleanups (a) shared constant and (d) repeated comment skipped.
- Observation, no action: if a Windows daemon's `runtime.json` rename is refused on all of core's retries (about 1 s), the daemon start fails with EPERM. No evidence it happens with production's 100 ms poll.
- Host note: the app refused to merge `main` into the worktree until the PM confirms the repository's pinned origin (Help → Troubleshooting → Review Pinned Git Origins).
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none · PM: M3 acceptance part two; IDE breakpoint check (batch 2 box).

## 2026-10-20 — M3 batch 5 — MCP db tools ready to merge

- Merged (lead, 2026-10-17): PR #36 `feat/database-tab` (batch 4) after reviewer approval, CI green (one test fixed for Windows 8.3 paths before merge) and QA pass; PLAN boxes "backends" and "Database tab" ticked. Deleted after merge (standing approval): worktree `agent-a061b3a5c6c5c4969` (unlocked first; clean and fully merged), local branches `feat/database-tab` and `worktree-agent-a061b3a5c6c5c4969`, remote branch `feat/database-tab`; QA artifacts copied to the main checkout first.
- Deleted by the batch 5 team (own items, standing approval): tester's temporary worktree `/tmp/claude-501/oldbase`; developer's `refs/original` backup ref after a subject-only reword (trees identical).
- Changed: `feat/mcp-db-tools` adds read-only MCP tools `db_list`, `db_schema`, `db_query`, `db_snapshot`, `db_diff` (no write tool), `flutterdeck init` writing `android.applicationId` and `ios.bundleId`, and the gate's `written` field with a fail-closed one-table edit rule. Tester MCP-1..MCP-10 fixed; reviewer R1–R8, R10, R11 and R1-b fixed (R9 cleanup skipped). For Claude the gate refuses CREATE text, hidden column defaults (table-valued pragma forms), bytecode EXPLAIN of pragmas, and any bytecode EXPLAIN while a column is hidden; the daemon clears hidden defaults in `PRAGMA table_info` results. QA PASS on fake mode and real Android through the MCP tools; evidence in [qa/M3.md](qa/M3.md).
- Lead decisions (2026-10-20): hidden columns also hide their defaults from Claude; Claude never reads CREATE text; flavor ids match `<id>.<suffix>` (same rule as the PM's 17 Oct acceptance).
- M3 acceptance: part one (row flash < 1 s) PASS in batch 4. Part two (Claude answers "how many orders are pending?" and confirms a change with `db_diff`) NOT RUN — the `claude` CLI on this Mac is logged out; needs the PM (log in, or Claude Desktop steps in [qa/M3.md](qa/M3.md) "PM check (batch 5)").
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none · PM: M3 acceptance part two; IDE breakpoint check (batch 2 box).

## 2026-10-17 — M3 batch 4 — Database tab ready to merge

- Merged (lead, 2026-10-17): PR #35 `feat/db-backends` (batch 3) after reviewer approval, CI green and QA pass; PLAN box "db-drift and db-sqlite backends" ticked. Deleted after merge (standing approval): worktree `agent-a68693af0659f700a`, local branches `feat/db-backends` and `worktree-agent-a68693af0659f700a`, remote branch `feat/db-backends`; QA artifacts copied to the main checkout first.
- Deleted by the batch 4 developer (own items, standing approval): scratch worktrees `wt-verify`, `wt-verify2`, `wt-evidence`; temporary branches `feat/database-tab-before-rewrite-tmp`, `feat/database-tab-rewrite-tmp`, `feat/database-tab-reword-tmp`. The branch history was rewritten before its first push so every commit passes (tester repros as `it.fails`/`test.fail`, flipped in each fix).
- Changed: `feat/database-tab` adds the dashboard Database tab (grid, row details, diagram, SQL editor with saved queries, snapshot and diff, export, guarded editing with an optimistic row check), the device picker, Activity entries and a real-SQL fake mode. Tester TAB-1..TAB-8 fixed; reviewer R1–R11, N1–N3, L1–L3 fixed over four rounds; QA B4-1..B4-7 fixed. QA PASS (fake mode and real Android; M3 Accept part one: new row flashes in about 220 ms). Evidence in [qa/M3.md](qa/M3.md).
- Lead decisions (2026-10-17): new-rows chip adds up until seen; gate-refused and "row changed" edits log "Write denied"; fake app cap 500; confirm dialog names the database and only the written table; toolbar Add row; developer copy for the device picker, Activity entries and tooltips confirmed. All in [ui/m3-database-tab.md](ui/m3-database-tab.md).
- Risk accepted by PM (2026-10-17): accepted: a device picked for an Android snapshot is accepted when its process is the app id or `<app id>.<suffix>` (Flutter flavors), so another debuggable app in the user's own namespace running at the same pid on the picked device could be copied — scope: db-sqlite device pick (review R2 residual) — expiry/review: before the M5 release — PM said: "Accept, review at M5 (Recommended)", whose description read "Recorded with today's date as a known limit, reviewed before M5. Flavors keep working with no setup."
- Known limit (design, not a defect): the optimistic edit check matches blobs by type, length and the sent prefix only (notes/database-tab.md item 9).
- Process note: QA and review must not run test suites in the same worktree at once (shared `qa-artifacts/` and CPU load made timing tests flake).
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none · PM: IDE breakpoint check (batch 2 box), optional removal of QA's app from the iPhone 17 simulator.

## 2026-10-17 — M3 batch 3 — db backends ready to merge

- Merged (lead, 2026-10-17): PR #34 `feat/flutterdeck-drift` (batch 2) after reviewer approval, CI green and QA pass. Deleted after merge (standing approval): worktree `agent-a7e012d8569777d5f`, local branches `feat/flutterdeck-drift` and `worktree-agent-a7e012d8569777d5f`, remote branch `feat/flutterdeck-drift`. QA artifacts copied to the main checkout first.
- Deleted by the batch 3 developer (own items, standing approval): temporary branch `db-backends-before-rebuild-tmp`, and throwaway scratchpad worktrees wt-b00, wt-fb5, wt-5f1, wt-4a0, wt-e89, wt-d9d, wt-9e1, wt-e82, wt-a63 and one detached at a72c92a.
- Changed: `feat/db-backends` adds `packages/android-adb`, `packages/db-drift` (live), `packages/db-sqlite` (Android and iOS simulator snapshots, read with sqlite-wasm), daemon `DbService` and `/api/db/*` routes, two-step dashboard edits and a fake mode. Tester DB-1..DB-10 fixed. Reviewer: two rounds plus a final check; R1–R12 and L1–L3 fixed. QA PASS on the Android emulator and iOS simulator (46/47; daemon-level not-debuggable path not run), Q1–Q2 fixed. Evidence in [qa/M3.md](qa/M3.md).
- Risk accepted by PM (2026-10-17): accepted: Claude driving the Browser pane uses the dashboard login, so it can read hidden columns from the Database tab page text; hidden columns protect Claude's FlutterDeck tools (db_query, db_diff), not the page — scope: M3 hidden columns (review N1) — expiry/review: before the M5 release — PM said: "Accept, review at M5 (Recommended)", whose description read "Record as a known limit next to the 'Claude could click an edit button' risk you accepted: hidden columns keep values out of Claude's tools (db_query, db_diff); if Claude reads the dashboard page it sees what you see. Reviewed before M5."
- Plan tasks (lead, 2026-10-17): device picker for `choose-device`, and Activity entries for snapshot, diff and edits → batch 4 (Database tab), owner developer. `flutterdeck init` writing `android.applicationId` / `ios.bundleId` → batch 5 (MCP and CLI), owner developer. Edit `execute` can wait up to 5 s behind a long read → batch 4 shows a busy state.
- Host note: QA's test app `dev.flutterdeck.qaDriftSample` stays installed on the iPhone 17 simulator (uninstalling needs the PM).
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none · PM: IDE check from batch 2 (not blocking).

## 2026-10-17 — M3 batch 2 — flutterdeck_drift ready to merge

- Merged (lead, 2026-10-16): PR #33 `feat/db-core` (batch 1) after reviewer approval, CI green (one rerun of the flaky plugin timing test T-P5-2, unrelated) and QA pass. Deleted after merge (standing approval): worktree `agent-a8a1f41ffe996a004`, local branches `feat/db-core` and `worktree-agent-a8a1f41ffe996a004`, remote branch `feat/db-core`. The developer of batch 2 deleted the `refs/original/` backup ref made by its subject-only reword (tree unchanged).
- Changed: `feat/flutterdeck-drift` adds the debug-only `dart/flutterdeck_drift` package, the sample app's Drift `orders` table, a CI job and a recorded fixture. Tester FD-1..FD-12 fixed. Reviewer: four rounds plus a final check (S1, CR-1..CR-6, D-2, D-3, R3-1..R3-5, R4-1 mitigated, R4-2 fixed, R5-1 lost interrupt fixed; CL-5 commented). QA on the Android emulator: F1 (writes lost during reads) fixed by the PM's "Read a copy" decision, F2 (busy on copy setup) fixed; final runs pass, evidence in [qa/M3.md](qa/M3.md). The schema reply now carries `sqlSchema` for the gate.
- Risk accepted by PM (2026-10-16): accepted: a hot restart that lands during an inspector copy (10–40 ms) leaves the copy's short-lived source connection open until the app exits — one file descriptor and at most about 64 KB of cache, debug builds only, no exposure, app writes unaffected — scope: `flutterdeck_drift` read copies (review R3-1/R4-1) — expiry/review: before the M5 release — PM said: "Accept, review at M5 (Recommended)", whose description read "Recorded with today's date as a known limit in docs/status.md, to be reviewed before the M5 release (a later pure-Dart fix using serialize/deserialize is listed as an option). Step 2 can merge once QA's final run passes."
- Notes for batch 3: a dashboard edit (`execute`) waits behind a long read on the same read isolate (up to 5 s; QA R5b) — show a busy state; when `sqlSchemaTruncated` is set the daemon gate must refuse queries (fail closed); schema entries may carry `error`; CREATE text is untrusted app text.
- PM check pending: IDE breakpoint plus Add order during a long read ([qa/M3.md](qa/M3.md), "PM check (batch 2)"); the PLAN box for `flutterdeck_drift` is ticked after it.
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none · PM: IDE check (not blocking the merge).

## 2026-10-16 — M3 batch 2 — PM decision on reads of apps not using WAL

- Changed: QA finding F1 (Android): an app write during a long inspector read failed at once with "database is locked", because the Dart profiler's signals cut SQLite's busy-handler sleeps short. Root cause and evidence in [notes/flutterdeck-drift.md](notes/flutterdeck-drift.md).
- Decision (PM, 2026-10-16): "Read a copy (Recommended)": for apps not using WAL, the inspector reads an in-memory copy made in small steps; the narrow debug-only busy timeout stays to cover the copy steps (closes D-1).

## 2026-10-16 — M3 batch 1 — db-core ready to merge

- Changed: `feat/db-core` adds core DB shapes (incl. `DbInspector.schemaSql`, tagged non-finite reals), `AppSession.extensions` with registry prefix rules, connector-dart `VmExtensions`, and the new `packages/sql-guard` (ADR 0005). Tester findings SG-1..SG-8, EXT-1, EXT-2 fixed. Reviewer: three rounds; S1–S8, D1–D2, C1–C7, N1–N2 all fixed; verdict approve with notes, no open findings. QA: PASS (29/29 gate checks, daemon unaffected, 2861 tests), evidence in [qa/M3.md](qa/M3.md); new rerun script `scripts/qa/check-sql-guard.mjs`. CLAUDE.md gains the `sql-guard` package row and commit scope.
- Notes for later batches: QA G1 — a view that selects a hidden column is refused whole (fails closed; batch 4 copy should say why). QA G2 — tables with triggers can't be edited, because a trigger counts as a second table (ADR 0005); batch 4 should explain this in the row editor. The gate only prepares statements; runtime limits for running queries belong to the backends (batch 3).
- Batch 2 (`feat/flutterdeck-drift`): tester found FD-1..FD-12 (FD-1 High: a leading `;` bypasses the app's token guard); developer fixing. Open PM question: debug-only `busy_timeout=7000` on the app's own Drift connection when none is set.
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none · PM: busy-timeout decision (not blocking batch 1).

## 2026-10-16 — M3 plan — design re-review fixes and PM decision on shell access

- Changed: the re-review (R1–R5) is fixed: reads are stopped with `sqlite3_interrupt` after 5 s, diff snapshots return row hashes from one short transaction, ADR 0004 and ADR 0005 carry "Amended 16 Oct 2026" sections, `db.allowFunctions` is dropped, the SQL editor runs reads only (edits in the row-details editor), query exports cap at 5,000 rows, `ios/Runner.xcodeproj` reading rules are in docs/notes/untrusted-project-files.md, stale deck and design lines updated.
- Risk accepted by PM (2026-10-16): accepted: Claude with shell access (Bash) can do anything the user can, including reading FlutterDeck's token, using the dashboard edit route or opening the database directly; FlutterDeck cannot block it and relies on Claude Code's Bash permission prompts — scope: the M3 design (review R5b) and FlutterDeck's threat model — expiry/review: before the M5 release — PM said: "Accept as outside FlutterDeck (Recommended)", whose description read "Recorded with today's date as a known limit: FlutterDeck protects against Claude's FlutterDeck tools and web pages, not against Claude using your shell. Keep Claude Code's permission prompts on for shell commands. Reviewed before the M5 release."
- Blockers: Developer none · Tester none · Reviewer none (final design check) · QA none · Marketer none · Lead none.

## 2026-10-16 — M3 plan — design review and PM decision on writes

- Changed: the reviewer blocked the M3 design (S1 High: a dashboard click can't prove a human approved a write; S2 High: runaway reads can freeze or kill the app; D1 High: 5 s MCP timeout vs 60 s confirm; S7: no command timeouts; plus Mediums on hidden columns, functions, locks, iOS paths, WAL and diff). The design note's new section "Design details after the design review" fixes them; UI spec, ADRs, deck, CLAUDE.md and PLAN.md updated.
- Decisions: PM, 16 Oct 2026, chose "Claude never writes (Recommended)" for how Claude's database writes work in M3.
- Risk accepted by PM (2026-10-16): accepted: with `db.allowWrites` on, Claude driving the Browser pane could still click an edit button in the Database tab — scope: M3 dashboard editing (design S1) — expiry/review: before the M5 release — PM said: "Claude never writes (Recommended)", whose description read "Remaining risk, written down: with writes on, Claude driving the Browser pane could still click an edit button."
- Blockers: Developer none · Tester none · Reviewer none (re-review of the design) · QA none · Marketer none · Lead none.

## 2026-10-16 — M3 plan — approved by PM

- Changed: M3 plan of record: [design note](design/m3-drift-inspector.md), [UI spec](ui/m3-database-tab.md), [deck](slides/m3-drift-inspector.html), [ADR 0004](adr/0004-app-extensions-in-core.md), [ADR 0005](adr/0005-read-only-sql-gate.md). Size: large. Research on 16 Oct 2026 corrected the plan's Android path (`app_flutter/`) and the snapshot WAL handling.
- Decisions (PM, 16 Oct 2026, chosen options word for word):
  - D1: "Our package only (Recommended)".
  - D2: "Rows, masked + capped (Recommended)".
  - D3: "Only if on + you click (Recommended)".
  - D4: "Add iOS simulator too". This changes the security rule on commands the daemon runs (`xcrun simctl`); CLAUDE.md and PLAN.md updated.
- Next: batch 1 `feat/db-core`.
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none.

## 2026-10-16 — M2 closed

- Changed: the PM ran the final M2 check in Claude Desktop (19 steps: init, plugin install, IDE breakpoint, dashboard next to chat, `r` / `Shift+R`, Claude's reloads, a failed reload with notification, Claude waiting and finished, breakpoint still hits, clean-up). PM said: "all passed, this looks great". M2 Accept ticked in PLAN.md.
- Decisions: none new.
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none.

## 2026-10-16 — M2 build complete — waiting for the PM check

- Changed: PR #29 (batch 5: plugin, hooks, notifications) merged after CI 8/8. One earlier CI run failed a timing-based test on macOS; the developer measured the scrub as linear up to 4 MB and made the test robust (8836c7a). PLAN.md: the four M2 build items are ticked; M2 Accept waits for the PM.
- Deleted (PM standing approval): worktree `agent-a11981da55891a256` and its branch; its `qa-artifacts/` were copied to the main checkout first.
- Follow-ups (Low): the header chip shows Claude's reload results only while the dashboard is open (Activity keeps them); the batch 4 EXDEV risk is fixed.
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none · PM: run the final M2 check (docs/qa/M2.md#final-pm-check).

## 2026-10-15 — M2 batch 5 (`feat/plugin-hooks`) — ready to merge

- Changed: the Claude Code plugin (manifest, `.mcp.json` with the Dart MCP server and FlutterDeck, hooks for Stop, SubagentStop, Notification, PostToolUse and PostToolUseFailure, a standalone hook script with health and project-id checks, scrubbed minimal payloads and a 2 s deadline), a dev marketplace at the repo root, `claude.reload` events paired with VM reload events, daemon OS notifications (app crashed, reload failed, Claude waiting; fixed per-OS commands, rate limit, switches), a 16 kB limit on `/api/events`, CLI EXDEV retry and plugin next steps, QA scripts with a scratch home.
- Gates: developer pass · tester pass (129 tests, T-P5-1..9 fixed) · reviewer: block (C1) → block (R2-1) → approve (all findings fixed, each with a failing-first test) · QA pass for hooks, notifications (recorded, no real popups) and a live run with a real Dart MCP client ([qa/M2.md](qa/M2.md)); final PM check written and rehearsed.
- Lead decisions: crash notification "App crashed — <app>" for crashes only; `elicitation_dialog` and `agent_needs_input` count as Claude waiting; the dev marketplace is accepted for M2; failed reload messages show their first line without the prefix; the header chip follows Claude's reloads; pairing rule per the design note (15 Oct).
- Host clean-up (PM standing approval): deleted `~/.flutterdeck`, created by a QA script run on 15 Oct (the scripts now use a scratch home).
- Open findings: none.
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none. PM: the final M2 check in Claude Desktop.

## 2026-10-15 — Masking hardening (`fix/masking-hardening`) — ready to merge

- Changed: one-pass decoding of broken escapes; unpadded auth codes found by their exact shape (VM service, DDS and DTD all use 8 random bytes in base64url: 11 characters, or 12 with `=`) on any loopback host form with a port; raw `?uri=ws://…` values; decoded first segments; encodings deeper than 3 levels fail closed.
- Gates: developer pass · tester pass (114 tests; N2-U1, N2-U2, I3-1, N2-O1 fixed) · reviewer block (R1, R2/R6) → approve with notes · QA 32/32 and 49 masking rows ([qa/M2.md](qa/M2.md)). Dated PLAN.md task ticked.
- Open findings (Low): L1 about 0.02% of unpadded codes (one letter case, no digit) are not masked, by design; L2 contrived host forms (`127.1`, decimal IPs, `[::1%25lo0]`) and a `%3F` before the code; L3 the N1 constant-factor lock is now a scaling test only.
- Lead decision: an 11-character mixed-case route on a local port such as `iPhone15Pro` is masked (fail closed); raised with the PM on 15 Oct.
- Process: removing a worktree deletes its `qa-artifacts/`; the lead now copies them to the main checkout's `qa-artifacts/` before removal. The batch 3 and 4 raw outputs were lost this way; the committed QA records keep the results.
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none.

## 2026-10-15 — M2 batch 4 (`feat/cli`) — ready to merge

- Changed: `packages/cli` (`flutterdeck init|start|stop|open|mcp`): init detects a Flutter app (YAML parsed safely), checks dart/flutter/adb through an allow-list, allocates the port, writes config.json, a marked .gitignore block and an attach-only `.claude/launch.json` entry under an init lock, inspects every file before writing and never follows links; start/stop/open reuse the MCP client (no auto-start in open, stop never kills a process); `pathScrubber` moved to core/node.
- Gates: developer pass · tester pass (77 tests, T1–T11 fixed) · reviewer approve with notes → re-review approve with notes (C1–C3, S1, S2, D1, D2, K1–K5 fixed) · QA 25/25, rerun 29/29 ([qa/M2.md](qa/M2.md)); live-app check skipped (emulator storage full; attach unchanged in this batch).
- Open findings (Low): N1 EXDEV when `.flutterdeck` is on another mount — fixed in batch 5.
- Lead decisions: `gh` is checked from M4; both the MCP server and `start` spawn the daemon entry (a CLI spawn would be a package cycle); an empty launch.json is treated as missing.
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none. PM (later): space on the Pixel_9_Pro emulator for the live M2 acceptance run.

## 2026-10-15 — Masking follow-ups (`fix/mcp-masking-followups`) — ready to merge

- Changed: auth codes in twice- and three-times-encoded VM service/DTD URIs, lenient decoding of broken escapes, fail-closed masking for URLs over 8 kB, fewer false positives on ordinary links, a single full stop in config warnings.
- Gates: developer pass · tester pass (47 tests, MF-T1–T3 fixed) · reviewer block (R1, a regression from the 8 kB cap) → approve with notes · QA 32/32 ([qa/M2.md](qa/M2.md)).
- Open findings (Low): N1 slower lenient decoding on long broken-escape runs (still linear), N2 short unpadded VM code (pre-existing), one rare nested bare shape — dated task in PLAN.md M2 (due 2026-10-20).

## 2026-10-15 — M2 batch 3 (`feat/mcp`) — merged

- Changed: PR #24 merged after two Windows-only CI fixes found by CI: a long-form Windows path leaked into a tool error (scrub now covers both realpath forms) and renames over `runtime.json` failed with EPERM while a reader had it open (bounded busy retry in core). Both reviewed. GitHub push protection rejected fake provider-shaped test tokens; the unpushed history was rewritten to build them at runtime (no bypass).
- Gates: as in the "ready to merge" entry, plus reviewer approval of 33b0127 and edd358b · CI 8/8.
- Open findings (Low): double-encoded VM service/DTD URIs and a double full stop in warnings — on `fix/mcp-masking-followups`.
- Decisions: PM, 2026-10-15: "you have permission to delete folders or files you have created, and you can switch between branches without my approval and run commands to this trusted folder". Deleted: the PM's `~/.flutterdeck` (created by the developer's manual run on 14 Oct; held only a salt and an empty project list), worktree `agent-a8f6500aab145bd92` and branch `worktree-agent-a8f6500aab145bd92`.
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none.

## 2026-10-15 — M2 batch 3 (`feat/mcp`) — ready to merge

- Changed: `packages/mcp` (stdio MCP server: `deck_status`, `get_logs`; best-effort masking at the output layer with built-ins and user rules in a budgeted worker; health-before-token; project id check; auto-start only in folders with `.flutterdeck/config.json`; daemon.log for start failures), core `@project-deck/core/node` (runtime/config/project id, safe file reads, budgeted worker), daemon regex queries in a worker with a 200 ms budget, every `.flutterdeck` file read and written without following links.
- Gates: developer pass · tester pass (116 tests, T1–T10 fixed) · reviewer: block (M1) → block (R1 High: symlinked daemon.log) → approve with notes (all findings fixed) · QA 30/30 fake mode, live app, planted-file checks ([qa/M2.md](qa/M2.md)).
- Open findings (Low, follow-up branch): a double-encoded VM service/DTD URI (`%253A%252F%252F…`) keeps its auth code; double full stop in two warnings (C5). C4 (a 74-character commit subject) skipped by the lead.
- Lead decisions: auto-start only in initialised folders; regex matched against message and stack separately; mcp depends on core only (daemon package used for path resolution).
- Note: the PM's `~/.flutterdeck/ports.json` (empty, salt only) was created on 14 Oct by the developer's manual run with the real HOME; tests now fail if the real `~/.flutterdeck` changes. Deleting it waits for the PM.
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none.

## 2026-10-14 — M2 batch 2 (`feat/dashboard`) — merged

- Changed: PR #22 merged (CI 8/8 incl. the e2e job).
- Decisions: PM, 2026-10-14, standing approval: "for the future you can delete any temporary branches you create". Deleted: `fix-format-tmp`, `worktree-agent-a4d427d7a267765e6`, `worktree-agent-a6c0f43418b929b85`, `worktree-agent-a6db11ab8d29d6906`, `worktree-agent-aab59232cd25923ae` (all commits already on other branches).
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none.

## 2026-10-14 — M2 batch 2 (`feat/dashboard`) — ready to merge

- Changed: `packages/dashboard` (header, Logs, Activity, all UI spec states, light/dark, 420/320 px, search in a Web Worker with a 200 ms budget), daemon serves the built assets behind auth, `discovering`, `logs.cleared`, log `seq` numbers, DTD app names parsed, styled Login needed page with a per-page CSP hash, Playwright E2E and a CI e2e job, all CI actions pinned to SHAs.
- Gates: developer pass · tester pass (122 tests, M2-T1/T2 fixed) · reviewer approve with notes → re-review approve (C1–C8, D2, D3, S1 fixed; D1 deferred with a Later line) · QA 38/38, rerun 38/38 incl. the live app ([qa/M2.md](qa/M2.md)).
- Open findings: B2-4 (test tooling): two Playwright runs in one worktree share `qa-artifacts/m2-dashboard/test-results` and flake — use a folder per run.
- Lead decisions: "Finding apps…" via a daemon `discovering` flag; no new-row flash for logs; app label "package · device" without "how started" when unknown; 4-row clamp means screen rows; copy "Search isn't working. Reload the page." and "Searching logs".
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead: PM answer on deleting team-made temporary local branches (`fix-format-tmp`).

## 2026-10-14 — M2 batch 1 (`feat/dashboard-auth`) — merged

- Changed: PR #20 merged. Config file, per-user port registry with lock, fixed port per project, cookie login with a 2-minute login window (ADR 0003), security headers, WS heartbeat, activity feed with crash detection, external reloads and hot restarts from VM events (recorded fixture).
- Gates: developer pass · tester pass (276 tests, T1–T5 fixed) · reviewer block (S1, C1, D1) → approve with notes · QA 39/39 real flow + 3/3 external reload/restart on the emulator ([qa/M2.md](qa/M2.md)) · CI 7/7 · merged by the lead under the PM's standing approval.
- Open findings: C4 (Low, accepted by the lead and documented: an external reload within 1 s after an own no-change reload is not shown). Known limitation: failed external reloads (compile error: no event; VM rejection: "success") until the batch 5 hook.
- Decisions: PM approved installing Playwright Chromium (`pnpm exec playwright install chromium`); PM approved deleting the local branches `reorder-tmp` and `reorder-tmp2` (done).
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none.

## 2026-10-14 — M2 batch 1 (`feat/dashboard-auth`) — PM decision on S1

- Changed: reviewer finding S1 (Medium): another OS user on the same machine could load `/` and get the dashboard cookie. Design fix in [ADR 0003](adr/0003-dashboard-login-window.md).
- Decisions: PM, 14 Oct 2026, chose the option "Login window (Recommended)": the cookie is handed out only during a 2-minute window opened at daemon start or with the `runtime.json` token (`flutterdeck open`, MCP server start). No risk accepted.
- Lead decisions: C1 — prune registry entries whose folder is gone; a duplicate checkout on a free port starts with a warning. `logs.rules` are plain regex strings; config port range 1024–65535. A wrong token header is refused even with a valid cookie.
- Host change approved by PM: delete the local branch `reorder-tmp` (done).
- Blockers: Developer none · Tester none · Reviewer none (re-review after the S1 and D1 fixes) · QA none · Marketer none · Lead none.

## 2026-10-14 — M1 closed

- Changed: merged PR #16 (CI runs the sample app's Flutter checks), PR #17 (M2 plan, decisions and ADRs) and PR #18 (M1 acceptance check). M1 Accept ticked in PLAN.md.
- Gates:
  - #16: developer pass · tester n/a — CI config only · reviewer approve with notes (C1–C3, D1–D3 fixed) · QA: first CI run green · merged by the lead under the PM's standing approval.
  - #17: lead design · reviewer: 3 rounds, block → approve with notes (all findings fixed, N1 fixed in the design text) · QA n/a — docs only · merged by the lead.
  - #18: developer pass · tester n/a — QA tooling, no product code · reviewer block (F1–F4) → approve with notes · QA rerun on the emulator 14 Oct 2026 PASS except the known upstream case · PM Android Studio check PASS · merged by the lead.
- Open findings (Low, follow-ups):
  - check-m1-acceptance.mjs R1/R2: a `stopping` flag so an interrupt can't race the source edit or add a duplicate row.
  - `android-sample-app.sh up` keeps stdout open, so `up | tail` hangs until `down`; point it at `examples/sample_app` (R5 from the sample app review).
  - `--control` has no "app runs the original code" row.
  - `GET /api/apps` has no `device` before attach.
  - Use the recorded JSON-RPC fixtures in the connector tests (F6); the daemon port test is unreliable under parallel runs; the emulator teardown leaves a stale DTD file.
  - F14 (shared QA script helpers) and F15 (old `qa` commit scope): cleanup, left by the lead.
- Decisions: none new.
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none.

## 2026-10-14 — M2 plan — approved by PM

- Changed: M2 plan of record: [design note](design/m2-dashboard.md), [UI spec](ui/m2-dashboard.md), [deck](slides/m2-dashboard.html), [ADR 0001](adr/0001-dashboard-login-cookie.md), [ADR 0002](adr/0002-fixed-dashboard-port.md). Size: large (new UI, browser trust boundary, MCP server, hooks, new notifier commands, logs with personal data sent to Claude). Claude Code formats checked on code.claude.com and npm on 14 Oct 2026.
- Gates: plan stage — PM approved the deck and design.
- Open findings: none.
- Decisions (PM, 14 Oct 2026, chosen options word for word):
  - D1: "Cookie the page can't read (Recommended)".
  - D2: "Fixed port per project (Recommended)".
  - D3: "Allow 3 fixed notifier commands (Recommended)". This changes the security rule on commands the daemon runs; CLAUDE.md and PLAN.md updated.
  - D4: "Mask by default (Recommended)".
- Next: batch 1 `feat/dashboard-auth` (config file and fixed port, cookie login, activity feed, security headers).
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none.

## 2026-10-14 — Sample app merged; PM decisions

- Merged: PR #14 (`examples/sample_app`). CI passes on Linux, macOS and Windows. Local: `pnpm check` 384 tests, `flutter analyze` clean, `flutter test` 24 tests.
- PM decisions:
  - R1: option A. CI runs the sample app's Flutter tests.
  - M1 criterion: a breakpoint that does not pause after a hot reload is an upstream Flutter limitation, not part of the check.
  - The lead merges PRs when the reviewer, CI and QA pass. Unfixed confirmed findings still need the PM.
  - Live Drift: own `flutterdeck_drift` package.
  - Name: the marketer prepares a shortlist; the PM chooses before M5.
  - M3 checkpoint: the team drafts the demo, guide and post; the PM publishes and collects feedback; M4 continues in parallel.
- Next: Flutter CI job, the M1 acceptance PR (`test/m1-acceptance`), and the PM's breakpoint check in Android Studio.
- **Blockers by role:** Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead: the M1 Accept box needs the PM's breakpoint check in Android Studio before M2 starts.

## 2026-10-14 — M1 acceptance (breakpoint check) — QA report (`test/m1-acceptance`)

- Changed:
  - QA added `scripts/qa/check-m1-acceptance.mjs`. It runs a sample app on the emulator, with a VM service client as the IDE debugger.
  - Result: 20 of 21 checks pass. The daemon lists the app, attaches, reloads and streams logs. The debugger stays connected. The breakpoint hits before and after attach, and after the daemon stops.
  - **Fail:** after a hot reload the breakpoint does not pause again. A control run with no daemon fails the same way, so this is upstream behaviour (Flutter tool or Dart VM), not FlutterDeck.
    PM decision, 14 Oct 2026 (PLAN.md M1 Accept line): an upstream Flutter limitation, not part of the check.
  - Evidence: [qa/M1.md](qa/M1.md#breakpoint-check-2026-10-14), `docs/qa/M1/screens/`; video `qa-artifacts/M1/m1-acceptance.mp4`.
- Gates: developer: rebased onto `main` and recorded the PM result · tester n/a — no product code · reviewer: blocked on F1–F4 (Medium) in the check script, plus Lows F6–F13; all fixed on the branch, re-review waiting · QA fail on one sub-check (upstream, out of scope by PM decision), rerun of the changed script waiting · PM merge waiting.
- Open findings: none in FlutterDeck. Minor: `GET /api/apps` has no `device` before attach.
- Decisions: PM, 14 Oct 2026 (PLAN.md M1 Accept line): a breakpoint that does not pause after a hot reload is an upstream Flutter limitation, not part of the check. PM result, 14 Oct 2026: in Android Studio the breakpoint hits while the daemon is attached. PASS.
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none.

## 2026-10-14 — Sample app (`feat/sample-app`) — waiting for PM merge approval

- Changed: new `examples/sample_app`, a Flutter app with a "Hit breakpoint" button (marked line `lib/main.dart:15`), a hot reload marker, and logs from print, `developer.log` and Android logcat (tag `FlutterDeckSample`). The README has the daemon steps. `examples/` is ignored by Prettier and ESLint. PLAN.md and CLAUDE.md mention the app.
- Gates:
  - developer pass (24 Flutter tests, analyze clean, debug APK builds, `pnpm check` 384);
  - tester pass (20 tests, B1 and B2 fixed);
  - reviewer approve with notes (R2, R3, R4, R6 fixed; R5 a follow-up; R1 waiting for a PM decision);
  - QA pass, 13/13 on the Pixel 9 Pro emulator ([qa/M1.md](qa/M1.md), screens `docs/qa/M1/screens/sample-*.png`, video `qa-artifacts/M1/sample-app.mp4`);
  - PM merge waiting.
- Open findings:
  - R1 (Low): CI doesn't run the Flutter tests. It needs a PM decision: a Flutter CI job, or a local-only exception.
  - R5 (cleanup): point `scripts/qa/android-sample-app.sh` at this app.
- Decisions: none yet.
- Blockers: Developer none · Tester none · Reviewer none · QA the real Android Studio breakpoint needs the PM · Marketer none · Lead merge approval and the R1 decision.

## 2026-10-13 — Team plugin pin moved to v0.2.1

- **PM decision (2026-10-13):** move the pin from v0.2.0 to v0.2.1. v0.2.1 adds stronger guard checks and has the lead brief the marketer only after the PM's recorded release approval.
- **Change:** `.claude/settings.json` `ref: v0.2.1`, and the version in CLAUDE.md "Team setup". No project rule changed.
- **Blockers by role:** Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none.

## 2026-10-13 — M1 close-out (`docs/m1-close-out`)

- Changed:
  - PR #8 (`.mcp.json` example) and PR #9 (`logs-android`) are merged to `main`. CI passes on all 6 jobs.
  - Plan boxes ticked for both items. QA results added to [qa/M1.md](qa/M1.md).
  - PR #10 closed: the my-tech-team plugin replaces the `deck-*` skills.
- Gates:
  - PR #9: developer pass · tester pass (8 bugs, fixed) · reviewer approve with notes (all notes fixed) · QA pass (9/9 emulator, 10/10 iOS) · PM merge approved.
  - PR #8: developer pass · tester n/a — no product code, config and a manual check script only · reviewer approve with notes (all notes fixed) · QA pass (check script) · PM merge approved.
  - This close-out: docs only, so tester, reviewer and QA are n/a.
- Open findings: none. Follow-ups:
  - use the recorded real JSON-RPC fixtures in the tests (F6);
  - make the daemon port test reliable under parallel runs;
  - the emulator teardown leaves a stale DTD discovery file.
- Decisions: PM (2026-10-13): "yes tick it, open the PR and close #10". This means: tick the `.mcp.json` item now (the FlutterDeck entry comes in M2), open the close-out PR, and close PR #10.
- Blockers: Developer none · Tester none · Reviewer none · QA the breakpoint check needs the PM's IDE · Marketer none · Lead none.

## 2026-10-13 — Team switch-over moved to plugin v0.2.0 (`chore/team-plugin`)

- **PM decisions (2026-10-13):**
  - pause the switch-over, build my-tech-team v0.2.0 first, then switch straight to v0.2.0;
  - v0.2.0 is released (automated testing with screenshot and video evidence, host-safety rules, guard hook).
- **Developer:**
  - rebased onto `main` (PRs #7–#9) with no conflicts;
  - pinned `ref: v0.2.0`;
  - added the Team setup keys: screenshots path, `qa-artifacts/`, end-to-end tools (Playwright for the dashboard; the Android scripts for app flows), "Approved tools: none yet";
  - added `qa-artifacts/` to `.gitignore`;
  - corrected the trust-boundary line (the plugin now has one ask-only guard hook).
- **Tester:** n/a — no code changed.
- **Open:**
  - reviewer re-check;
  - QA re-run for v0.2.0 (the earlier QA record covers v0.1.0);
  - PM check steps and merge approval.
- **Blockers by role:** Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none.

## 2026-10-13 — Team switched to the my-tech-team plugin (`chore/team-plugin`)

- **PM decisions (2026-10-13):**
  - pin the plugin to v0.1.0;
  - run the switch-over in parallel with the open work;
  - delete the old `docs/team-roles` branch after merge.
- **Lead:** design note `docs/design/team-plugin.md` and deck `docs/slides/team-plugin.html`. Size: large, because it adds a new outside integration.
- **Developer:** handed off 5 commits:
  - settings pinned to v0.1.0;
  - CLAUDE.md "Team setup" with every FlutterDeck rule from the old skills;
  - PLAN "Later" section;
  - status log intro;
  - old `deck-*` skills removed.
    The 2026-10-12 entry was already on `main`, so there was nothing to copy.
- **Tester:** n/a — no code changed.
- **Reviewer:** first pass blocked on R1 (Medium): the project-rules override sentence could relax the plugin's risk rule. Fixed, along with R2 and N1. Re-review: approve with notes. N2 (commit scope) was skipped as cleanup.
- **QA:** 5/7 pass. The `ref: v0.1.0` pin is confirmed by the published settings schema. The install from the tag gives version 0.1.0 with 6 skills. The headless sentence failed first, was fixed, and passed on re-run. Not observed: loading from project settings in a trusted folder, which needs the PM's interactive check. Evidence: `docs/qa/team-plugin.md`.
- **Open:** PM check steps (`docs/qa/team-plugin.md#pm-check`), then PM approval of the merge route.
- **Blockers by role:** Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none.

## 2026-10-12 — M1 at risk (connector approved; port clash and CI found)

- **Connector (`feat/connector-dart`, PR #3):** approved with notes after the full team flow:
  - first review: 9 findings, all fixed;
  - tester: 8 bugs (B1–B8), all fixed;
  - second review: blocked on 6 findings, including real compile errors being misreported; all fixed;
  - re-review: approved.
  - Security review clean. 159 tests pass, and every commit builds alone.
  - Open, non-blocking: F6 recorded fixtures (QA), F7 framework label (needs a core change), N1 failed-start release ordering (low), N2 60 s CLI result cache (low).
- **QA found:** the default daemon port **9100 clashes with Dart DevTools**, which Android Studio starts on 9100. On a typical Flutter machine the daemon can't start there, and `main.ts` crashes with a raw stack trace instead of a clear message.
- **CI has never run:** the workflow is active and Actions is enabled, but GitHub shows 0 runs for PRs #1–#3.
- **Other PRs:** #1 (team roles) and #2 (README and corrected DTD notes) are waiting for PM approval.
- **Blockers by role:**
  - **Developer:** waiting for the PM to choose the new default port, then fixes the clash and the crash message. Until then the real-app check must use `--port`.
  - **Tester:** none.
  - **Reviewer:** none.
  - **QA:** needs the PM to run a Flutter app from Android Studio to finish acceptance and record real fixtures (F6).
  - **Lead:** needs PM approval to merge PRs #1–#3, and needs the PM to check the repo's Actions page for why CI doesn't run.

## 2026-10-11 — M1 at risk (connector findings open)

- **Merged to `main`:** scaffold, `core`, daemon. Code review found 10 issues, all fixed with regression tests. Security review found nothing above threshold.
- **On branch `feat/connector-dart` (not merged):** finds running apps automatically through the Dart Tooling Daemon, plus pasted addresses, and attaches for reload, restart and logs. 98 tests pass. Smoke-tested against the live Android Studio DTD.
  - Code review: **9 open findings**. Two crash risks (malformed addresses, listener exceptions), an unhandled rejection from the scan timer, an isolate refresh race after hot restart, every reload error labelled "compile error", calls hanging while a socket closes, a session leak when attach overlaps stop, a timer outliving detach, and fixtures not yet recorded from a live app.
  - Security review: nothing above threshold. One hardening note: on Windows, run the `dart` fallback from a fixed working directory.
- **Decided:** DTD discovery order. Reload failure shows "Reload failed" plus recent error logs.
- **On branch `docs/team-roles`:** team role skills and CLAUDE.md roles section.
- **Blockers by role:**
  - **Developer:** needs the go-ahead to fix the 9 connector findings (PM). Until then the connector can't merge.
  - **Tester:** none.
  - **Reviewer:** none (waiting for the developer's fixes to re-review).
  - **QA:** needs a sample app started from the IDE to record real fixtures, and later the M1 acceptance run with a breakpoint (PM). Without it, connector tests rely on spec-built data.
  - **Lead:** needs approval to merge `docs/team-roles` (PM). The remote is now set up: public repo https://github.com/Thamzy265/project-deck, so merges can go through pull requests.
