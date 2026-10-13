# Team status log

Kept by the lead (`/my-tech-team:lead` skill). Newest entry first. Each entry records what changed, open findings and blockers, so PM updates can say what changed "since last update".

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
- **Open:** reviewer (rule-by-rule check), QA (load check and version pin), PM merge approval.
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
