# QA — team-plugin (switch to the my-tech-team plugin v0.1.0)

Date: 2026-10-13 — Environment: macOS 27.0.1, Claude Code 2.1.236, git 2.50.1, Node.js 22.12.0, branch `chore/team-plugin` at `04ab956` (QA worktree). Every `claude` command ran with `CLAUDE_CONFIG_DIR` set to a fresh, empty folder in the QA scratchpad (written `<qa-config>` below), never the PM's own config. Plugin repo tag `v0.1.0` = commit `677f908` (`git ls-remote --tags https://github.com/Thamzy265/my-tech-team.git`).

Design note: [docs/design/team-plugin.md](../design/team-plugin.md). Criteria from the lead's QA brief.

| #   | Criterion                                                                                                                                                                                                  | Result                                                     | Evidence                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `.claude/settings.json` is valid JSON with exactly the two keys `extraKnownMarketplaces` (github source `Thamzy265/my-tech-team`, `ref: v0.1.0`) and `enabledPlugins` (`my-tech-team@my-tech-team: true`). | PASS                                                       | See [1](#1-settings-file).                                                                                                                                                             |
| 2   | `ref` is supported in a project `extraKnownMarketplaces` github source.                                                                                                                                    | PASS                                                       | The published schema accepts it, the docs document `ref` for github sources, and the CLI itself writes this exact shape. See [2](#2-ref-is-supported).                                 |
| 3   | With an isolated config the tagged plugin installs, is version 0.1.0 and has 6 skills (developer, lead, marketer, qa, reviewer, tester); then removed.                                                     | PASS                                                       | See [3](#3-tagged-plugin-installs).                                                                                                                                                    |
| 4   | Project-settings path: Claude Code picks up the project's `extraKnownMarketplaces` / `enabledPlugins`.                                                                                                     | NOT OBSERVED — needs PM                                    | Untrusted folder: the marketplace and plugin were silently ignored, as documented. Trust needs the interactive dialog. Moved to PM check steps 5–6. See [4](#4-project-settings-path). |
| 5   | CLAUDE.md "headless `claude -p` runs ignore them" is correct.                                                                                                                                              | FAIL — claim too broad                                     | The docs say `-p` runs ignore them only in an untrusted folder; in a trusted folder they apply. Soften the sentence. See [5](#5-headless-claim).                                       |
| 5   | (re-run after fix `92caa11`) CLAUDE.md headless sentence matches the docs.                                                                                                                                 | PASS (re-run 2026-10-13)                                   | The new wording limits the ignore to untrusted folders and adds the first-turn caveat; each part matches a doc quote. See [5, re-run](#5-re-run-2026-10-13-after-92caa11).             |
| 6   | Old skills gone: `git ls-files .claude/skills` empty; no `deck-*` references outside history (`docs/status.md`, `docs/design`, `docs/slides`).                                                             | PASS                                                       | See [6](#6-old-skills-gone).                                                                                                                                                           |
| 7   | PM check steps written and run.                                                                                                                                                                            | Written; partly run — interactive steps NOT RUN — needs PM | Step 4 run here. Step 3 fails while the QA worktree holds the branch (reproduced). Steps 1–3 and 5–9 need the PM. See [PM check](#pm-check).                                           |

## Evidence

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

## Not observed

- The project-settings path in a trusted folder (criterion 4): needs the interactive trust dialog on the PM's machine. PM check steps 5–6.
- `/my-tech-team:lead` loading and `/deck-lead` being gone in a real session: needs an interactive, signed-in session. PM check steps 7–8.
- PM check steps 1–3 and 9 in the PM's own checkout (`~/Developer/Personal/project-deck`): QA must not switch branches there. Step 3's failure while the QA worktree exists was reproduced in a throwaway repo instead (see PM check).

## PM check

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
