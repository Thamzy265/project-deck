# QA — team-plugin (switch to the my-tech-team plugin)

The branch now pins **v0.2.0**. The current results are in [v0.2.0 re-run (2026-10-13)](#v020-re-run-2026-10-13) and the current PM steps in [PM check](#pm-check). The v0.1.0 run below is kept as history; rows it no longer covers are marked superseded.

## v0.1.0 run (history)

Date: 2026-10-13 — Environment: macOS 27.0.1, Claude Code 2.1.236, git 2.50.1, Node.js 22.12.0, branch `chore/team-plugin` at `04ab956` (QA worktree). Every `claude` command ran with `CLAUDE_CONFIG_DIR` set to a fresh, empty folder in the QA scratchpad (written `<qa-config>` below), never the PM's own config. Plugin repo tag `v0.1.0` = commit `677f908` (`git ls-remote --tags https://github.com/Thamzy265/my-tech-team.git`).

Design note: [docs/design/team-plugin.md](../design/team-plugin.md). Criteria from the lead's QA brief.

| #   | Criterion                                                                                                                                                                                                  | Result                                                                                  | Evidence                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `.claude/settings.json` is valid JSON with exactly the two keys `extraKnownMarketplaces` (github source `Thamzy265/my-tech-team`, `ref: v0.1.0`) and `enabledPlugins` (`my-tech-team@my-tech-team: true`). | PASS (v0.1.0) — superseded by [v0.2.0 #1](#v020-1-settings-file)                        | See [1](#1-settings-file).                                                                                                                                                       |
| 2   | `ref` is supported in a project `extraKnownMarketplaces` github source.                                                                                                                                    | PASS — schema re-checked for v0.2.0, see [v0.2.0 #1](#v020-1-settings-file)             | The published schema accepts it, the docs document `ref` for github sources, and the CLI itself writes this exact shape. See [2](#2-ref-is-supported).                           |
| 3   | With an isolated config the tagged plugin installs, is version 0.1.0 and has 6 skills (developer, lead, marketer, qa, reviewer, tester); then removed.                                                     | PASS (v0.1.0) — superseded by [v0.2.0 #2](#v020-2-tagged-plugin-installs)               | See [3](#3-tagged-plugin-installs).                                                                                                                                              |
| 4   | Project-settings path: Claude Code picks up the project's `extraKnownMarketplaces` / `enabledPlugins`.                                                                                                     | NOT OBSERVED — needs PM (re-run for v0.2.0: [v0.2.0 #4](#v020-4-project-settings-path)) | Untrusted folder: the marketplace and plugin were silently ignored, as documented. Trust needs the interactive dialog. Moved to the PM check. See [4](#4-project-settings-path). |
| 5   | CLAUDE.md "headless `claude -p` runs ignore them" is correct.                                                                                                                                              | FAIL — claim too broad (superseded by the re-run below)                                 | The docs say `-p` runs ignore them only in an untrusted folder; in a trusted folder they apply. Soften the sentence. See [5](#5-headless-claim).                                 |
| 5   | (re-run after fix `92caa11`) CLAUDE.md headless sentence matches the docs.                                                                                                                                 | PASS (re-run 2026-10-13) — superseded by [v0.2.0 #5](#v020-5-headless-sentence)         | The new wording limits the ignore to untrusted folders and adds the first-turn caveat; each part matches a doc quote. See [5, re-run](#5-re-run-2026-10-13-after-92caa11).       |
| 6   | Old skills gone: `git ls-files .claude/skills` empty; no `deck-*` references outside history (`docs/status.md`, `docs/design`, `docs/slides`).                                                             | PASS (v0.1.0) — superseded by [v0.2.0 #6](#v020-6-old-skills-gone)                      | See [6](#6-old-skills-gone).                                                                                                                                                     |
| 7   | PM check steps written and run.                                                                                                                                                                            | Superseded — the v0.1.0 steps are replaced by the v0.2.0 [PM check](#pm-check)          | Step 4 run here. Step 3 fails while the QA worktree holds the branch (reproduced). Steps 1–3 and 5–9 needed the PM. See [PM check — v0.1.0](#pm-check--v010-superseded).         |

## Evidence (v0.1.0)

### 1. Settings file

```bash
node -e 'const s=JSON.parse(require("fs").readFileSync(".claude/settings.json","utf8"));console.log(Object.keys(s));console.log(JSON.stringify(s.extraKnownMarketplaces));console.log(JSON.stringify(s.enabledPlugins))'
```

```text
[ 'extraKnownMarketplaces', 'enabledPlugins' ]
{"my-tech-team":{"source":{"source":"github","repo":"Thamzy265/my-tech-team","ref":"v0.1.0"}}}
{"my-tech-team@my-tech-team":true}
```

Schema check (ajv 6.15.0 from project-deck's `node_modules`, against the schema from criterion 2): `valid`. Negative control (an unknown key `reff` added to the source): `invalid (expected)`, so the check does reject bad keys.

### 2. `ref` is supported

`curl -sSL https://json.schemastore.org/claude-code-settings.json` (HTTP 200, 231 533 bytes). Under `properties.extraKnownMarketplaces.additionalProperties.properties.source.anyOf`, the `github` branch (with `additionalProperties: false`):

```json
"source": { "const": "github" },
"repo": { "description": "GitHub repository in owner/repo format" },
"ref": { "description": "Git branch or tag to use (e.g., \"main\", \"v1.0.0\"). Defaults to repository default branch." },
"required": ["source", "repo"]
```

Docs (`https://code.claude.com/docs/en/settings-reference.md`, marketplace source table): github — "`repo` required; `ref` is a branch or tag; `path` is a subdirectory". The `extraKnownMarketplaces` section itself shows a github example without `ref`; the table above is in the `strictKnownMarketplaces` section and uses the same source objects. `discover-plugins.md`: "Add `#ref` to pin a branch or tag."

Behaviour: after `claude plugin marketplace add Thamzy265/my-tech-team#v0.1.0` (criterion 3), Claude Code wrote this into `<qa-config>/settings.json`, the same shape as the project file:

```json
"extraKnownMarketplaces": {
  "my-tech-team": { "source": { "source": "github", "repo": "Thamzy265/my-tech-team", "ref": "v0.1.0" } }
}
```

### 3. Tagged plugin installs

Run from an empty folder (not the repo), `CLAUDE_CONFIG_DIR=<qa-config>/c3` (empty before), `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`.

```bash
claude plugin marketplace add 'Thamzy265/my-tech-team#v0.1.0'
claude plugin marketplace list
claude plugin install my-tech-team@my-tech-team
claude plugin details my-tech-team
```

```text
Cloning repository (timeout: 120s): https://github.com/Thamzy265/my-tech-team.git (ref: v0.1.0)
✔ Successfully added marketplace: my-tech-team (declared in user settings)
  ❯ my-tech-team
    Source: GitHub (Thamzy265/my-tech-team@v0.1.0)
✔ Successfully installed plugin: my-tech-team@my-tech-team (scope: user)
my-tech-team 0.1.0
Component inventory
  Skills (6)  developer, lead, marketer, qa, reviewer, tester
  Agents (0)
  Hooks (0)
  MCP servers (0)
  LSP servers (0)
Projected token cost
  Always-on:   ~378 tok   added to every session
```

Cloned marketplace HEAD: `677f908796580dce354fbc779afaff98882f5783` (= tag `v0.1.0`). No hooks, MCP servers or agents, which matches the design note's trust section. The plugin's marketplace entry uses `"source": "./"` (a relative path), which matters for criterion 4.

Removal:

```bash
claude plugin uninstall my-tech-team@my-tech-team
claude plugin marketplace remove my-tech-team
claude plugin list
claude plugin marketplace list
```

```text
✔ Successfully uninstalled plugin: my-tech-team (scope: user)
✔ Successfully removed marketplace: my-tech-team
No plugins installed. Use `claude plugin install` to install a plugin.
No marketplaces configured
```

### 4. Project-settings path

From inside the worktree, with a second fresh config `CLAUDE_CONFIG_DIR=<qa-config>/c4`:

```bash
claude plugin marketplace list
claude plugin list
claude plugin details my-tech-team
```

```text
No marketplaces configured
No plugins installed. Use `claude plugin install` to install a plugin.
Plugin "my-tech-team" not found. Run `claude plugin list` to see installed plugins, or pass --plugin-dir <path> to load one from disk.
```

`<qa-config>/c4/.claude.json` has no `projects` entry, so the folder is untrusted. This matches the docs (settings-reference, `extraKnownMarketplaces`): "in a folder you haven't trusted, including a `-p` run there, it ignores them without a message." Trusting needs the interactive dialog (which a fresh config puts after sign-in). QA did not sign in or edit config files to get around it, so this goes to the PM.

What the PM should see once trusted (`plugins/loading.md`): a project-only `true` is not fetched "unless its marketplace entry has a relative-path source", and "A relative-path plugin needs no install record because it loads from the marketplace itself." `my-tech-team` uses `"source": "./"`, so it should load without `claude plugin install`. Note that `plugins/install.md` ("Project scope") says collaborators must run `claude plugin install <name>@<marketplace> --scope project` once; that is the rule for external sources, so PM step 6 keeps it as the fallback.

### 5. Headless claim

CLAUDE.md, "Team setup": "Claude Code loads the repo settings only after the folder is trusted, and headless `claude -p` runs ignore them."

Docs say otherwise for trusted folders:

- `plugins/org.md`, "Require plugins per repository": "Non-interactive `-p` runs: the entries apply only in a folder whose trust the user already accepted interactively, or whose `hasTrustDialogAccepted` flag you set in `~/.claude.json`."
- Same page, surface table, row "`-p` and CI": "`extraKnownMarketplaces` in trusted folders only; `enabledPlugins` applied". It adds that in `-p` runs plugins install in the background, "so a plugin can be missing from the first turn" (`CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1` makes the run wait).

So the claim is wrong for a folder already trusted interactively. Also, only `extraKnownMarketplaces` (and other trust-gated keys) wait for trust, not every repo setting. Suggested wording for the developer: "Claude Code applies the repo's marketplace entry only after the folder is trusted. In an untrusted folder, including a headless `claude -p` run there, it ignores it without a message. In `-p` runs the plugin installs in the background, so it can be missing from the first turn."

### 5. Re-run 2026-10-13 after `92caa11`

`git show --stat 92caa11` changes only `CLAUDE.md` (1 line). `sed -n 95p CLAUDE.md` now ends:

> Claude Code reads these settings only after the folder is trusted. In an untrusted folder, including a headless `claude -p` run there, it ignores them without a message. In `-p` runs the plugin installs in the background, so it can be missing on the first turn.

Docs re-fetched today (`curl -sSL https://code.claude.com/docs/en/plugins/org.md` and `.../settings-reference.md`, both HTTP 200); the quotes are unchanged:

| New sentence                                                                                            | Doc line                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "reads these settings only after the folder is trusted"                                                 | `settings-reference.md:4666`: "Claude Code honors entries in a repository's `.claude/settings.json` … only after you accept the workspace trust dialog for that folder"                                                                |
| "In an untrusted folder, including a headless `claude -p` run there, it ignores them without a message" | `settings-reference.md:4666`: "in a folder you haven't trusted, including a `-p` run there, it ignores them without a message"; `org.md:90`: `-p` entries "apply only in a folder whose trust the user already accepted interactively" |
| "the plugin installs in the background, so it can be missing on the first turn"                         | `org.md:108`: "marketplaces and plugins install in the background, so a plugin can be missing from the first turn"                                                                                                                     |

Result: PASS. Minor note, not blocking: the docs gate on trust only `extraKnownMarketplaces` (`org.md:105`: "`enabledPlugins` applied"), so "these settings" is slightly broad. In effect it holds, because the plugin can't load until its marketplace is registered.

### 6. Old skills gone

```bash
git ls-files .claude/skills | wc -l
ls -A .claude
git grep -n -E 'deck-(lead|developer|qa|reviewer|tester|marketer)|\.claude/skills/deck'
git grep -n -E '(/|`)deck-' -- ':!docs/slides' ':!docs/design'
```

```text
       0
settings.json
docs/design/team-plugin.md:7:  ... began here as `.claude/skills/deck-*` (PR #1) ...
docs/design/team-plugin.md:18: 2. Delete `.claude/skills/deck-*`.
docs/design/team-plugin.md:32: - Rollback: ... restores `.claude/skills/deck-*` ...
docs/slides/team-plugin.html:369,440,448,456,463,472,588 (old skill names in the migration table and the check slide)
docs/status.md:17:  - old `deck-*` skills removed.
```

Every hit is in history (design note, slides, status log). CLAUDE.md, PLAN.md and code have none.

## Not observed (v0.1.0)

- The project-settings path in a trusted folder (criterion 4): needs the interactive trust dialog on the PM's machine. PM check steps 5–6.
- `/my-tech-team:lead` loading and `/deck-lead` being gone in a real session: needs an interactive, signed-in session. PM check steps 7–8.
- PM check steps 1–3 and 9 in the PM's own checkout (`~/Developer/Personal/project-deck`): QA must not switch branches there. Step 3's failure while the QA worktree exists was reproduced in a throwaway repo instead (see PM check).

## PM check — v0.1.0 (superseded)

Superseded by the v0.2.0 [PM check](#pm-check) at the end of this file. Kept as history; do not use these steps.

Before you start:

- Claude Code is installed and you are signed in. Takes about 5 minutes.
- The lead has removed the QA worktree for `chore/team-plugin`. Until then, step 3 fails with `already used by worktree`.
- In `~/Developer/Personal/project-deck`, `main` has no uncommitted changes of yours.

1. Open a new terminal and go to the project folder.

   ```bash
   cd ~/Developer/Personal/project-deck
   ```

   Expected: no output. If you see `no such file or directory`, the project is somewhere else; tell the lead.

2. Check that you haven't installed the plugin yourself.

   ```bash
   claude plugin list
   ```

   Expected: `my-tech-team` is not in the list. If it is listed, tell the lead: the check below can't tell your own install apart from the project setting.

3. Switch to the branch.

   ```bash
   git switch chore/team-plugin
   ```

   Expected: `Switched to branch 'chore/team-plugin'`. If you see `fatal: 'chore/team-plugin' is already used by worktree at ...`, the QA worktree still exists: ask the lead to remove it, then redo this step. If you see `Your local changes ... would be overwritten`, stop and tell the lead.

4. Check that the old skills folder is gone.

   ```bash
   ls -A .claude
   ```

   Expected: only `settings.json`. If you also see `skills`, tell the lead.

5. Start Claude Code in this folder.

   ```bash
   claude
   ```

   Expected: Claude Code asks whether you trust this folder. Choose yes. If it doesn't ask, you trusted it before; carry on. If it asks to add the `my-tech-team` marketplace or plugin, accept.

6. In Claude Code, type `/plugin` and press Enter, then open the **Installed** tab.

   Expected: `my-tech-team` is listed, enabled, version `0.1.0`. On the **Marketplaces** tab, `my-tech-team` shows source `Thamzy265/my-tech-team@v0.1.0`. Press Esc to close.

   If it is not listed at all, the folder isn't trusted: type `/exit` and redo step 5. If the **Errors** tab says `Plugin "my-tech-team" is enabled in project settings but isn't installed here`, type `/exit`, run the command below, redo step 5, and tell the lead you needed it.

   ```bash
   claude plugin install my-tech-team@my-tech-team --scope project
   ```

7. Type `/my-tech-team:lead` and press Enter.

   Expected: the lead skill loads and Claude answers as the team lead. If you see `Unknown skill` (or the command isn't suggested as you type), tell the lead.

8. Type `/deck-lead` and press Enter.

   Expected: it isn't suggested as you type, and Claude Code says it doesn't know that command. If the old lead skill runs, tell the lead (a copy may still exist outside this repo, for example in `~/.claude/skills`).

9. Type `/exit` to leave Claude Code, then switch back.

   ```bash
   git switch main
   ```

   Expected: `Switched to branch 'main'`. The folder stays trusted and the `my-tech-team` marketplace stays registered in your Claude Code; both are needed after the merge, so leave them.

What QA ran (2026-10-13):

- Step 4 in the QA worktree: `ls -A .claude` → `settings.json`. Pass.
- Step 3's failure while a worktree holds the branch, reproduced in a throwaway repo (`git init`, `git worktree add <wt> chore/team-plugin`, then `git switch chore/team-plugin` in the main checkout): `fatal: 'chore/team-plugin' is already used by worktree at '<wt>'`, exit 128. The real QA worktree holds this branch today (`git worktree list` in project-deck), so step 3 fails until the lead removes it.
- Step 6's expected version, skill count and source line come from the isolated-config run in criterion 3 (`my-tech-team 0.1.0`, `Skills (6)`, `Source: GitHub (Thamzy265/my-tech-team@v0.1.0)`). The `/plugin` panel itself was not seen.
- Steps 1, 2, 3, 5, 6, 7, 8 and 9: NOT RUN — needs PM.

## v0.2.0 re-run (2026-10-13)

Date: 2026-10-13 — Environment: macOS 27.0.1, Claude Code 2.1.236, git 2.50.1 (Apple Git-155), Node.js 22.12.0, branch `chore/team-plugin` at `27e0aae` (QA worktree). Plugin repo tag `v0.2.0` = commit `2769a36` (`git ls-remote --tags https://github.com/Thamzy265/my-tech-team.git`: `2769a36f3594b8ccc0d39cb07c07b53051004d34 refs/tags/v0.2.0^{}`). Every `claude` command ran with `CLAUDE_CONFIG_DIR` set to a fresh, empty folder under the QA scratchpad (written `<qa-config2>` below; deleted after the run), never the PM's own config. Network: github.com, code.claude.com and json.schemastore.org only.

Every row was re-run today; no v0.1.0 result is carried over.

| #   | Criterion                                                                                                                                                                                                  | Automated / manual                                          | Tool and command                                                                     | Result                                                     | Evidence                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | `.claude/settings.json` is valid JSON with exactly the two keys `extraKnownMarketplaces` (github source `Thamzy265/my-tech-team`, `ref: v0.2.0`) and `enabledPlugins` (`my-tech-team@my-tech-team: true`). | automated                                                   | node + ajv 6.15.0 against the re-fetched settings schema                             | PASS                                                       | [v0.2.0 #1](#v020-1-settings-file)                             |
| 2   | With an isolated config the tagged plugin installs; `claude plugin details` shows version 0.2.0, Skills (6), Hooks (1) PreToolUse; then uninstalled and removed.                                           | automated                                                   | `claude plugin marketplace add / install / details / uninstall / marketplace remove` | PASS                                                       | [v0.2.0 #2](#v020-2-tagged-plugin-installs)                    |
| 3   | The installed v0.2.0 guard hook answers `git reset --hard` with an "ask" decision and `git status` with no output.                                                                                         | automated                                                   | `printf '<json>' \| sh <installed>/hooks/guard.sh`                                   | PASS                                                       | [v0.2.0 #3](#v020-3-guard-hook)                                |
| 4   | Project-settings path: Claude Code picks up the project's `extraKnownMarketplaces` / `enabledPlugins` in a trusted folder.                                                                                 | manual — needs the interactive trust dialog (needs-PM list) | `claude plugin marketplace list / list / details` in the untrusted worktree          | NOT OBSERVED — needs PM                                    | [v0.2.0 #4](#v020-4-project-settings-path); PM check steps 6–7 |
| 5   | CLAUDE.md headless sentence still accurate (unchanged since the v0.1.0 re-run).                                                                                                                            | automated                                                   | `git diff`, `sed`, `curl` the docs, `grep` the quotes                                | PASS                                                       | [v0.2.0 #5](#v020-5-headless-sentence)                         |
| 6   | Old skills gone; no `deck-*` references outside history; `qa-artifacts/` is in `.gitignore`.                                                                                                               | automated                                                   | `git ls-files`, `git grep`, `git check-ignore`                                       | PASS                                                       | [v0.2.0 #6](#v020-6-old-skills-gone)                           |
| 7   | PM check steps updated for v0.2.0 and run where QA can.                                                                                                                                                    | manual — trust dialog, signed-in session, PM's own checkout | see [PM check](#pm-check)                                                            | Written; partly run — interactive steps NOT RUN — needs PM | [PM check](#pm-check)                                          |

### v0.2.0 #1. Settings file

```bash
node -e 'const s=JSON.parse(require("fs").readFileSync(".claude/settings.json","utf8"));console.log(Object.keys(s));console.log(JSON.stringify(s.extraKnownMarketplaces));console.log(JSON.stringify(s.enabledPlugins))'
```

```text
[ 'extraKnownMarketplaces', 'enabledPlugins' ]
{"my-tech-team":{"source":{"source":"github","repo":"Thamzy265/my-tech-team","ref":"v0.2.0"}}}
{"my-tech-team@my-tech-team":true}
```

Schema re-fetched today: `curl -sSL https://json.schemastore.org/claude-code-settings.json` → HTTP 200, 231 533 bytes. Validated with ajv 6.15.0 (from project-deck's `node_modules/.pnpm`): `valid`. Negative control (unknown key `reff` added to the source): `invalid (expected)`. This also re-verifies v0.1.0 criterion 2 (`ref` is accepted in a github source).

### v0.2.0 #2. Tagged plugin installs

Run from an empty folder (not the repo), `CLAUDE_CONFIG_DIR=<qa-config2>/c2` (empty before: `ls -A` printed nothing), `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`.

```bash
claude plugin marketplace add 'Thamzy265/my-tech-team#v0.2.0'
claude plugin marketplace list
claude plugin install my-tech-team@my-tech-team
claude plugin details my-tech-team
```

```text
Cloning repository (timeout: 120s): https://github.com/Thamzy265/my-tech-team.git (ref: v0.2.0)
✔ Successfully added marketplace: my-tech-team (declared in user settings)
  ❯ my-tech-team
    Source: GitHub (Thamzy265/my-tech-team@v0.2.0)
✔ Successfully installed plugin: my-tech-team@my-tech-team (scope: user)
my-tech-team 0.2.0
Component inventory
  Skills (6)  developer, lead, marketer, qa, reviewer, tester
  Agents (0)
  Hooks (1)  PreToolUse  (harness-only — no model context cost)
  MCP servers (0)
  LSP servers (0)
Projected token cost
  Always-on:   ~378 tok   added to every session
```

`<qa-config2>/c2/plugins/installed_plugins.json`: `"version": "0.2.0"`, `"gitCommitSha": "2769a36f3594b8ccc0d39cb07c07b53051004d34"` (= tag `v0.2.0`), install path `<qa-config2>/c2/plugins/cache/my-tech-team/my-tech-team/0.2.0`. The installed `.claude-plugin/plugin.json` says `"version": "0.2.0"`. No MCP servers or agents, which matches the design note's trust section ("one Claude Code hook … It has no MCP servers").

Removal:

```bash
claude plugin uninstall my-tech-team@my-tech-team
claude plugin marketplace remove my-tech-team
claude plugin list
claude plugin marketplace list
```

```text
✔ Successfully uninstalled plugin: my-tech-team (scope: user)
✔ Successfully removed marketplace: my-tech-team
No plugins installed. Use `claude plugin install` to install a plugin.
No marketplaces configured
```

### v0.2.0 #3. Guard hook

Installed copy (before the uninstall above): `<qa-config2>/c2/plugins/cache/my-tech-team/my-tech-team/0.2.0/hooks/`. `hooks.json` registers one `PreToolUse` hook, matcher `Bash`, command `sh "${CLAUDE_PLUGIN_ROOT}/hooks/guard.sh"`, timeout 10. The script was read before it was run: it only reads stdin, matches patterns and prints one `ask` decision or nothing; the only decision it can print is `"ask"` (never `deny`). `diff -r` of the cache's `hooks/` and the marketplace clone's `hooks/`: identical.

```bash
printf '{"tool_name":"Bash","tool_input":{"command":"git reset --hard"}}' | sh <installed>/hooks/guard.sh
printf '{"tool_name":"Bash","tool_input":{"command":"git status"}}' | sh <installed>/hooks/guard.sh
```

```text
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"my-tech-team guard: git reset --hard discards uncommitted work. Approve only if you expected this command."}}
[exit 0, 217 bytes]
[exit 0, 0 bytes]   (git status: no output)
```

Extra check of the CLAUDE.md examples ("for example `git reset --hard`, force-push, `sudo` or installs"), same way, all exit 0 with `"permissionDecision":"ask"`:

| Command                        | Reason printed                                |
| ------------------------------ | --------------------------------------------- |
| `git push --force origin main` | force-push rewrites remote history            |
| `sudo ls`                      | runs a command as administrator (sudo)        |
| `brew install jq`              | installs or upgrades software on this machine |

What the PM should see (docs, `curl -sSL https://code.claude.com/docs/en/hooks.md`, HTTP 200): `permissionDecisionReason` "For `"ask"`, shown to the user in the permission prompt", and the prompt carries a source label, `[plugin:<name>]` for a plugin's hook (`hooks.md:1910`, `:1918`). The hook firing inside a live Claude Code session was not observed (needs a signed-in interactive session): PM check step 10.

### v0.2.0 #4. Project-settings path

From inside the worktree, with a second fresh config `CLAUDE_CONFIG_DIR=<qa-config2>/c4`:

```bash
claude plugin marketplace list
claude plugin list
claude plugin details my-tech-team
```

```text
No marketplaces configured
No plugins installed. Use `claude plugin install` to install a plugin.
Plugin "my-tech-team" not found. Run `claude plugin list` to see installed plugins, or pass --plugin-dir <path> to load one from disk.
```

`<qa-config2>/c4/.claude.json` has no `projects` entry (`grep -c projects` → `0`), so the folder is untrusted and the project settings are ignored, as documented. Trust needs the interactive dialog, so this stays a PM step (steps 6–7). QA did not sign in or edit config files to get around it.

### v0.2.0 #5. Headless sentence

`git diff --word-diff b2540ac..HEAD -- CLAUDE.md` (from the v0.1.0 headless re-run commit to now): in line 95 the only changes are `v0.1.0` → `v0.2.0` and two new sentences about the guard hook at the end (the other CLAUDE.md changes are new Team setup and QA bullets). The three headless sentences are byte-for-byte the ones that passed the v0.1.0 re-run:

> Claude Code reads these settings only after the folder is trusted. In an untrusted folder, including a headless `claude -p` run there, it ignores them without a message. In `-p` runs the plugin installs in the background, so it can be missing on the first turn.

Docs re-fetched today (`curl -sSL https://code.claude.com/docs/en/plugins/org.md` → HTTP 200, 40 264 bytes; `.../settings-reference.md` → HTTP 200, 421 502 bytes). The quotes are unchanged and still at the same lines: `settings-reference.md:4666` ("in a folder you haven't trusted, including a `-p` run there, it ignores them without a message"), `org.md:90` (`-p` entries "apply only in a folder whose trust the user already accepted interactively"), `org.md:108` ("a plugin can be missing from the first turn"). Result: PASS. The v0.1.0 minor note stands (`org.md:105`: "`enabledPlugins` applied" in `-p`, so "these settings" is slightly broad; not blocking).

The new guard sentences also hold: the four named examples all get an `ask` (see #3), and "never replaces the roles' own Host safety rule" is a rule, not a behaviour to test.

### v0.2.0 #6. Old skills gone

```bash
git ls-files .claude/skills | wc -l
ls -A .claude
git grep -n -E 'deck-(lead|developer|qa|reviewer|tester|marketer)|\.claude/skills/deck'
git grep -n -E '(/|`)deck-' -- ':!docs/slides' ':!docs/design'
git check-ignore -v qa-artifacts/x.webm
```

```text
       0
settings.json
docs/design/team-plugin.md:7, :18, :32  (history: how the skills began, the delete step, rollback)
docs/qa/team-plugin.md  (this QA record)
docs/slides/team-plugin.html:369,440,448,456,463,472,588  (migration table and check slide)
docs/status.md:35  (old `deck-*` skills removed)
scripts/qa/android-sample-app.sh:8,19, scripts/qa/check-android-logs.mjs:59, packages/logs-android/src/adb.test.ts:307  (temp-folder names `project-deck-qa-android`, `deck-qa-android-`, `deck-adb-kill-`; not role skills)
.gitignore:12:qa-artifacts/	qa-artifacts/x.webm
```

Every role-skill hit is in history (design note, slides, status log, QA record). CLAUDE.md, PLAN.md, `.claude/` and code have none. `git grep -n 'v0\.1\.0' -- ':!docs/qa'` hits only `docs/status.md` history lines.

### Not observed (v0.2.0)

- The project-settings path in a trusted folder (criterion 4): needs the interactive trust dialog. PM check steps 6–7.
- The `/plugin` panel's details view (version, skills, hook) in a real session: expected values come from `claude plugin details` in #2. PM check step 7.
- The guard hook firing in a live session and the prompt's `[plugin:my-tech-team]` label: the script's answer was checked directly (#3) and the label is from the docs. PM check step 10.
- `/my-tech-team:lead` loading and `/deck-lead` being gone: needs a signed-in interactive session. PM check steps 8–9.
- PM check steps 1–3 and 11 in the PM's own checkout: QA must not switch branches there, and the QA worktree holds the branch.

## PM check

Before you start:

- Claude Code is installed and you are signed in. The check takes about 10 minutes.
- **The lead has removed the QA worktree for `chore/team-plugin` first.** Until then, step 3 fails with `already used by worktree`.
- In `~/Developer/Personal/project-deck`, `main` has no uncommitted changes of yours.

1. Open a new terminal and go to the project folder.

   ```bash
   cd ~/Developer/Personal/project-deck
   ```

   Expected: no output. If you see `no such file or directory`, the project is somewhere else; tell the lead.

2. Check that you haven't installed the plugin yourself.

   ```bash
   claude plugin list
   ```

   Expected: `my-tech-team` is not in the list. If it is listed, tell the lead: the check below can't tell your own install apart from the project setting.

3. Switch to the branch.

   ```bash
   git switch chore/team-plugin
   ```

   Expected: `Switched to branch 'chore/team-plugin'`. If you see `fatal: 'chore/team-plugin' is already used by worktree at ...`, the QA worktree still exists: ask the lead to remove it, then redo this step. If you see `Your local changes ... would be overwritten`, stop and tell the lead.

4. Check that the old skills folder is gone.

   ```bash
   ls -A .claude
   ```

   Expected: only `settings.json`. If you also see `skills`, tell the lead.

5. Check that the folder has no unsaved changes (step 10 relies on this).

   ```bash
   git status
   ```

   Expected: the last line is `nothing to commit, working tree clean`. If it lists changed files, skip step 10 and tell the lead.

6. Start Claude Code in this folder.

   ```bash
   claude
   ```

   Expected: Claude Code asks whether you trust this folder. Choose yes. If it doesn't ask, you trusted it before; carry on. If it asks to add the `my-tech-team` marketplace or plugin, accept.

7. In Claude Code, type `/plugin` and press Enter, then open the **Installed** tab.

   Expected: `my-tech-team` is listed, enabled, version `0.2.0`. Select it to see its details: 6 skills (developer, lead, marketer, qa, reviewer, tester) and 1 hook (PreToolUse). On the **Marketplaces** tab, `my-tech-team` shows source `Thamzy265/my-tech-team@v0.2.0`. Press Esc to close.

   If it shows version `0.1.0`, tell the lead. If it is not listed at all, the folder isn't trusted: type `/exit` and redo step 6. If the **Errors** tab says `Plugin "my-tech-team" is enabled in project settings but isn't installed here`, type `/exit`, run the command below, redo step 6, and tell the lead you needed it.

   ```bash
   claude plugin install my-tech-team@my-tech-team --scope project
   ```

8. Type `/my-tech-team:lead` and press Enter.

   Expected: the lead skill loads and Claude answers as the team lead. If you see `Unknown skill` (or the command isn't suggested as you type), tell the lead.

9. Type `/deck-lead` and press Enter.

   Expected: it isn't suggested as you type, and Claude Code says it doesn't know that command. If the old lead skill runs, tell the lead (a copy may still exist outside this repo, for example in `~/.claude/skills`).

10. Optional guard check. Type this message to Claude and press Enter:

    `Run git reset --hard in this folder. I am testing the my-tech-team guard and will choose No.`

    Expected: a permission prompt for the command that names the guard: it is labelled `[plugin:my-tech-team]` and says `my-tech-team guard: git reset --hard discards uncommitted work. Approve only if you expected this command.` Choose **No**. If Claude asks you in chat first, reply `Yes, run it`, and choose No at the prompt.

    How to tell it failed: the prompt doesn't mention the my-tech-team guard, or the command runs without any prompt. Tell the lead either way. Nothing is lost, because step 5 showed the folder was clean.

11. Clean up: type `/exit` to leave Claude Code, then switch back.

    ```bash
    git switch main
    ```

    Expected: `Switched to branch 'main'`. The folder stays trusted and the `my-tech-team` marketplace stays registered in your Claude Code; both are needed after the merge, so leave them.

What QA ran (2026-10-13):

- Step 4 in the QA worktree: `ls -A .claude` → `settings.json`. Pass.
- Step 5 in the QA worktree: `git status` → `nothing to commit, working tree clean`. Pass.
- Step 2's command with a fresh, empty config in the worktree: `No plugins installed. ...`. Pass (not the PM's own config).
- Step 3's failure while a worktree holds the branch, re-run today in a throwaway repo (`git init`, `git worktree add <wt> chore/team-plugin`, then `git switch chore/team-plugin` in the main checkout): `fatal: 'chore/team-plugin' is already used by worktree at '<tmp>/wt'`, exit 128. `git worktree list` in project-deck shows the QA worktree holds `chore/team-plugin` today, so step 3 fails until the lead removes it.
- Step 7's expected version, counts and source line come from #2 (`my-tech-team 0.2.0`, `Skills (6)`, `Hooks (1) PreToolUse`, `Source: GitHub (Thamzy265/my-tech-team@v0.2.0)`). The `/plugin` panel itself was not seen.
- Step 10's expected reason text comes from running the installed guard directly (#3); the `[plugin:my-tech-team]` label comes from the docs (`hooks.md:1918`). Not seen in a live session.
- Steps 1, 2 (in the PM's config), 3, 6, 7, 8, 9, 10 and 11: NOT RUN — needs PM.
