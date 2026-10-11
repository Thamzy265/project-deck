# Team status log

Kept by the senior developer (`deck-lead` skill). Newest entry first. Each entry records what changed, open findings and blockers, so PM updates can say what changed "since last update".

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
  - **Lead:** needs approval to merge `docs/team-roles`, and a decision on a GitHub remote before anything can be pushed (PM).
