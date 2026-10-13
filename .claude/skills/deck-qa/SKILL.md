---
name: deck-qa
description: Use when checking a project-deck milestone's acceptance criteria for real, smoke-testing a merged feature end to end, or deciding whether a plan checkbox can be ticked.
---

# QA

## Overview

Tests prove the code matches our understanding. QA proves it works for a real Flutter developer. You run the actual product against the acceptance criteria in `docs/PLAN.md` and record evidence. A box is ticked only with evidence.

## Procedure

1. Copy the milestone's acceptance criteria into `docs/qa/<milestone>.md`, one checklist line each.
2. For each line, run the real flow:
   - Build first with `pnpm build`.
   - Start the daemon with `node packages/daemon/dist/main.js`.
   - Exercise it with `curl` and the token from `.flutterdeck/runtime.json`.
   - `node scripts/dtd-apps.mjs` shows which apps the DTDs can see.
3. Record each result: pass or fail, the exact commands, the relevant output with tokens and auth codes masked, and the date and environment (OS, Dart/Flutter versions).
4. Steps that need the project manager's machine (start the app from Android Studio or VS Code, set a breakpoint, look at a device) go to the lead as a short, numbered request. Never pretend they ran.
5. A failure becomes a bug for the developer, with steps to reproduce.

## Automated checks (default)

The PM checks results at a high level; QA does the work. For every finished task with behaviour that can run for real:

1. **Write a check script** in `scripts/qa/check-<feature>.mjs`. It sets up what it needs (temp project dir, daemon on a free port), exercises the real product, prints a `CHECK / RESULT / DETAIL` table, ends with "All N checks passed." or the failures, exits non-zero on any failure, masks tokens and auth codes, and cleans up after itself.
2. **Script the environment** when the check needs one, e.g. `scripts/qa/android-sample-app.sh up|down` boots an emulator and runs a throwaway sample Flutter app. Use a scratch folder and a sample app; never the PM's own projects, IDE, adb server or running apps. Tear down only what you started.
3. **Run it yourself** end to end, then commit the scripts as `test(qa): ...` on the feature branch.
4. **Report** the summary table exactly as printed, plus **one command** the PM can run to repeat it (`up && check && down`).
5. Record the result (date, environment, summary) in `docs/qa/<milestone>.md`.

Hand the PM numbered manual steps only for what can't be automated (e.g. "set a breakpoint in Android Studio and confirm it hits"), in the format described in `deck-lead`, after running them yourself where possible.

## Also capture

When a real app session runs, record the JSON-RPC traffic as fixtures for the developer, with auth codes and personal data removed. CLAUDE.md requires recorded fixtures for connector tests.

## Blockers

Report a blocker to the lead as soon as it appears; don't wait for the hand-off. Give one line each: **what** is blocking you, **who** can unblock it (developer, tester, reviewer, QA, lead or PM), **what you need**, and the **impact** if it isn't resolved. Write "Blockers: none" when there are none, so silence is never ambiguous.

## Report (to the lead, who logs it in `docs/status.md`)

```markdown
Milestone: <M#> — <n>/<n> criteria pass
Fail: <criterion> — <observed vs expected> — repro: <steps>
Needs PM: <numbered steps the PM must do>
Evidence: docs/qa/<milestone>.md
Check script: <scripts/qa/...> — <N/N pass> — rerun: `<one command>`
Blockers: <none | what — who can unblock — what I need — impact>
```

## Common mistakes

| Mistake                                    | Fix                                                       |
| ------------------------------------------ | --------------------------------------------------------- |
| Ticking a box because the unit tests pass  | Acceptance needs the real flow                            |
| Pasting raw tokens or VM service URIs      | Mask them; they grant access                              |
| Skipping the "breakpoint still hits" check | It's the reason the product attaches instead of launching |
