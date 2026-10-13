# Design note: switch to the my-tech-team plugin

Date: 2026-10-13. Status: approved by the PM (deck: [docs/slides/team-plugin.html](../slides/team-plugin.html)).

## Context

The team-role skills began here as `.claude/skills/deck-*` (PR #1). They are now released as the public plugin [`my-tech-team` v0.1.0](https://github.com/Thamzy265/my-tech-team/releases/tag/v0.1.0), which is generic. The plugin adds a marketer role, MVP phases with a Later list, system-design, UI and privacy checks, and slides for large items. Keeping two copies would let them drift apart.

## Requirements and non-goals

- Every Claude session that opens and trusts this repo loads the plugin skills as `/my-tech-team:<role>`.
- No FlutterDeck rule from the old skills is lost. Project-specific rules live in CLAUDE.md under "Team setup".
- Non-goals: no change to package code, tests, CI, the milestone process, the review gate, the Git workflow or the PR format.

## Decision

1. `.claude/settings.json` declares the marketplace (GitHub `Thamzy265/my-tech-team`, pinned to `ref: v0.1.0`) in `extraKnownMarketplaces`, and enables `my-tech-team@my-tech-team` in `enabledPlugins`.
2. Delete `.claude/skills/deck-*`.
3. CLAUDE.md: replace "Team roles" with "Team setup" (paths, commands, phase, privacy regions and per-role project rules).
4. `docs/PLAN.md` gains an empty "Later" section. `docs/status.md` gains a switch-over entry. The 2026-10-12 entry is already on `main`.

Options considered: pin to a tag (chosen; upgrades are a one-line PR the PM approves) or follow `main`.

## Trust boundaries and abuse cases

- New outside source: the plugin repo on GitHub. It contains skills only, with no hooks, MCP servers or scripts.
- Abuse case: a bad change to the skills repo silently changes agent behaviour here. Mitigations: the tag pin; Claude Code ignores repo settings until the folder is trusted; upgrades go through a PR.

## Rollout and rollback

- Rollout: merge after the PR is approved. Sessions pick up the plugin the next time they open the folder.
- Rollback: revert the merge commit. That restores `.claude/skills/deck-*` and the old CLAUDE.md section.

## Later lines

None.
