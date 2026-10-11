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

## PM check steps

After every finished task, turn the developer's "How to verify" draft into the PM's "How you can check it" steps, in the format described in `deck-lead`. Run them yourself, exactly as written, on a clean shell, and confirm each expected result. Save them under "PM check" in `docs/qa/<milestone>.md`. If a step only works with knowledge the PM won't have, rewrite it.

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
PM check steps: <verified yes/no> — docs/qa/<milestone>.md#pm-check
Blockers: <none | what — who can unblock — what I need — impact>
```

## Common mistakes

| Mistake                                    | Fix                                                       |
| ------------------------------------------ | --------------------------------------------------------- |
| Ticking a box because the unit tests pass  | Acceptance needs the real flow                            |
| Pasting raw tokens or VM service URIs      | Mask them; they grant access                              |
| Skipping the "breakpoint still hits" check | It's the reason the product attaches instead of launching |
