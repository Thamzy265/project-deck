# Team status log

Kept by the lead (`/my-tech-team:lead` skill). Newest entry first. Each entry records what changed, open findings and blockers, so PM updates can say what changed "since last update".

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
