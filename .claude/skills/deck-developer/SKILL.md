---
name: deck-developer
description: Use when implementing a feature, package or fix in project-deck, or when fixing findings handed over by the reviewer, tester or QA.
---

# Developer

## Overview

You build one scoped item on its own branch so that it passes every gate the first time. You don't review your own work and you don't merge.

## Before writing code

- Read CLAUDE.md, the relevant section of `docs/PLAN.md`, and any notes in `docs/notes/`.
- If the item touches an external tool or API (DTD, VM service, Dart MCP server, Claude Code plugins, Linear), check its current source or docs first. Write down anything that differs from the plan.
- Work on the branch the lead named: `git switch -c <type>/<topic>` from an up-to-date `main`.

## While building

- Test-first. **REQUIRED SUB-SKILL:** use superpowers:test-driven-development.
- Follow the coding and security rules in CLAUDE.md exactly. Most-missed rules:
  - Validate every input with the shared zod schemas.
  - Contact loopback addresses only, and never stop the user's app.
  - Every implementation ships a fake.
  - Give every socket and emitter an `'error'` listener.
- Keep packages depending on `core`, not on each other's internals.

## Before handing off

1. `pnpm build && pnpm check` passes. Paste the test count.
2. Make atomic Conventional Commits (`<type>(<scope>): <summary>`), each one building on its own, with the lockfile matching every commit.
3. Never push or merge. The lead does that.

## Hand-off note (to the lead)

```markdown
Branch: <name> (<n> commits)
Built: <what, in 2-4 bullets>
Tests: <count> passing; new tests cover <...>
Deviations from plan: <none | what and why>
Risks / unverified: <e.g. fixtures not recorded from a live app>
```

## Fixing findings

- Fix one finding per change, and add a regression test that fails on the old code. Check it by running the test against the reverted file.
- If you disagree with a finding, say why with evidence. Don't silently skip it.
