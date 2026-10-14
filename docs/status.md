# Team status log

Kept by the lead (`/my-tech-team:lead` skill). Newest entry first. Each entry records what changed, open findings and blockers, so PM updates can say what changed "since last update".

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
