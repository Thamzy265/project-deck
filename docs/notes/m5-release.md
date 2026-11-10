# M5 release: facts checked

Date: 2026-11-10. Read-only research for the M5 plan. Sources are cited per section; all were read on 10 Nov 2026. "Not verified" marks anything taken from secondary sources or not tested.

## 1. Claude Code plugin and marketplace

Sources: code.claude.com/docs/en/plugin-marketplaces, /plugins-reference (manifest), /plugins/publish.md, /plugins/host-marketplace.md, /mcp.

**Marketplace format**

- `.claude-plugin/marketplace.json` at the marketplace root. Required: `name`, `owner` (`{ name }`), `plugins[]`. Each entry needs `name` and `source`; `description`, `displayName`, `version` are optional.
- Sources: relative path (`"./plugin"`, no `..`), `github` (`{ source, repo, ref?, sha? }`), `git-subdir` (`{ source, url: "owner/repo", path }`), `url`, `archive` (zip over HTTPS, pin with `sha256`), `npm`, `command`.
- Relative paths work only when the marketplace is a git repo or a directory (the whole tree is cloned). A bare `marketplace.json` URL breaks them.
- Entry `name` must equal the `name` in `plugin.json` (the install id is `<entry>@<marketplace>`; skills are namespaced by the manifest name).
- Marketplace `name` must be unique per user; names like `claude-plugins-official` are reserved. Plugin names starting `claude-`, `anthropic-`, `cc-plugin-` fail validation.
- `renames` map (append-only) migrates users if a plugin is renamed. Never rename a published plugin; change `displayName` instead.

**User install (from a GitHub repo)**

```
claude plugin marketplace add Thamzy265/project-deck
claude plugin install flutterdeck@<marketplace-name>
# one step, CLI >= 2.1.292:
claude plugin install flutterdeck --marketplace Thamzy265/project-deck
```

In a session: `/plugin marketplace add …`, then `/plugin install …`. Users without a GitHub SSH key should set `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` (in-session installs and updates do not fall back to HTTPS). Claude Desktop uses the + → Plugins menu (notes/claude-code-plugin.md).

**plugin.json fields**

- Only `name` is required. Recommended for release: `displayName`, `version`, `description`, `author`, `homepage` (must parse as a URL or the plugin fails to load), `repository`, `license`, `keywords`.
- Directory-listing only (ignored by Claude Code): `icon`, `documentationUrl`, `supportUrl`, `privacyPolicyUrl`, `termsOfServiceUrl`.
- `claude plugin validate --strict ./plugin` is the CI check; it warns on a missing `version`, `description` or `author`. MCP entry checks need CLI >= 2.1.281.

**Versioning and updates**

- With `version` set, users stay on that copy until the string changes. Without it, the git commit SHA is the version. Do not set it in both `plugin.json` and the marketplace entry (`plugin.json` wins; validate reports the mismatch).
- Auto-update is **off by default** for third-party marketplaces; users turn it on under `/plugin` → Marketplaces, or run `claude plugin update flutterdeck@<mkt>`.
- `claude plugin tag [--push]` creates `{name}--v{version}` tags; needed only if other plugins depend on ours.
- Pin a plugin to a ref with `ref`/`sha` on a `github`/`git-subdir` source; users can pin the catalog with `owner/repo#ref`.

**`.mcp.json` and `npx`**

- A stdio server is `{ command, args, env }`; `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` and `${CLAUDE_PROJECT_DIR}` substitute in `command`, `args`, `env`, and are exported to the process. `CLAUDE_PROJECT_DIR` is now exported to MCP servers (notes/claude-code-plugin.md said it wasn't, 15 Oct); our `--project` could use it.
- The docs do not forbid `"command": "npx"`; any command on `PATH` works. Not verified: whether Windows needs `cmd /c npx` (npx is `npx.cmd`). The MCP page does not say. Smoke-test it on Windows.
- `npx` assumes `--yes` when stdin is not a TTY (docs.npmjs.com/cli/v11/commands/npm-exec), so it won't hang on a prompt under Claude Code. Still pass `-y` and pin a version (`npx -y <pkg>@<x.y.z> mcp`) so a plugin version maps to one CLI version and no unpinned registry lookup happens on each start.
- Alternative: `npm`-source plugin or vendoring the bundled CLI inside the plugin and running `node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js mcp`. That removes the npx start-up cost and the version skew, at the price of committing a build artifact (or a release branch).

**Official and community marketplaces**

- Anthropic's directory (claude.ai/directory) takes submissions through the developer portal, claude.ai/directory/manage. Needs a paid claude.ai plan; listed plugins reach Claude Code as `<name>@synced`. The portal applies extra rules (claude.com/docs/plugins/pre-submission-checklist, not read). Some components are Claude Code-only (claude.com/docs/plugins/platform-support, not read): our hooks and stdio servers need local Node/Dart, so claude.ai/Cowork users get little.
- `claude-plugins-official` takes no submissions through the portal (partner contacts only).
- Community marketplaces: none checked. Self-hosting (our repo) needs no approval.

**What `plugin/` is missing today**

- `.mcp.json` runs `${CLAUDE_PLUGIN_ROOT}/../packages/cli/dist/main.js`. That works only in place; any installed copy lives in `~/.claude/plugins/cache/…`. Must switch to `npx` (or a vendored bundle).
- Root `.claude-plugin/marketplace.json` is the dev marketplace `flutterdeck-dev`. M5 needs a public one: either rename/replace it in this repo (source `./plugin`, which clones the whole monorepo) or a `git-subdir` source, or a separate small marketplace repo. `init.ts` (lines ~391–433) prints the dev install commands and detects `flutterdeck-dev`; it needs a release path.
- `plugin.json`: `version` 0.0.0; no `homepage`, `repository`, `author.url`; author is "FlutterDeck contributors".
- `plugin/` also holds `package.json`, `test/`, `evals/`, `tsconfig.json`, `vitest.*` (and a local `node_modules/`, git-ignored). These are copied into users' caches; harmless but noisy. Consider a `plugin/` that holds only shipped files, or accept it.
- Bundles a second `dart mcp-server`. Users who already have the official `dart-flutter` plugin (seen in this session: `mcp__plugin_dart-flutter_dart-mcp-server__*`) get two Dart servers. The hook matcher already accepts both.
- No CI step runs `claude plugin validate --strict` (plugin tests check shapes instead).

## 2. npm release of the CLI

Sources: docs.npmjs.com/trusted-publishers, docs.npmjs.com/cli/v11/commands/npm-exec, registry checks with curl.

**Current packages** (all version 0.0.0, none `private` except the root and `plugin/`):

| Package                                                                                                            | Notes                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `@project-deck/cli`                                                                                                | `bin: { flutterdeck: ./dist/main.js }`; deps: android-adb, core, daemon, mcp, jsonc-parser, yaml        |
| `@project-deck/daemon`                                                                                             | depends on connector-dart, core, dashboard, db-drift, db-sqlite, logs-android, sql-guard, hono, ws, zod |
| `@project-deck/dashboard`                                                                                          | React + CodeMirror as runtime deps; only `dist/` (828 KB) is needed at run time                         |
| `@project-deck/core`, `connector-dart`, `logs-android`, `android-adb`, `mcp`, `db-drift`, `db-sqlite`, `sql-guard` | libraries                                                                                               |

Registry (10 Nov 2026): `flutterdeck`, `project-deck`, `@project-deck/cli` all 404 (free); the npm scope/org `project-deck` does not exist. `npx flutterdeck` today would fetch an unscoped package named `flutterdeck` that we don't own: squat risk until the name is chosen and claimed.

**Option A: publish every package under the scope**

- `pnpm publish -r` rewrites `workspace:*` to real versions. Needs the `@project-deck` npm org, 11 packages, lockstep versions (changesets or one script), `files`/`exports` already point at `dist`.
- `npx` installs the full tree, including React, CodeMirror and TanStack for the dashboard even though only its built `dist/` is used. Slower first start; more packages exposed as public API.
- Asset lookup works unchanged (`createRequire(...).resolve('@project-deck/dashboard/package.json')` in `daemon/src/dashboard-assets.ts`; workers via `new URL('./worker.js', import.meta.url)` in `sql-guard/src/guard.ts` and `db-sqlite/src/engine.ts`).

**Option B: one bundled package (recommended to evaluate first)**

- Bundle `cli` with tsup/esbuild into one ESM package; mark internal packages as bundled, keep a few pure-JS runtime deps external (`ws`, `hono`, `@hono/node-server`, `@modelcontextprotocol/sdk`, `zod`, `yaml`, `jsonc-parser`, `@sqlite.org/sqlite-wasm`) or bundle them too.
- Must copy in: dashboard `dist/` (change `defaultDashboardDir` to a path next to the bundle), the two worker entry points as separate bundle entries (`sql-guard` worker, `db-sqlite` worker) at the paths `new URL('./worker.js', …)` expects, and the sqlite-wasm `.wasm` file (dist is 2.9 MB) where sqlite-wasm loads it from. Not verified: how sqlite-wasm's Node build locates its `.wasm` once bundled; keeping `@sqlite.org/sqlite-wasm` external avoids the question.
- One package to name, version and publish; smallest `npx` download; internal APIs stay private. Needs a test that runs the packed tarball (section 5).
- "No native Node modules" holds for both options: no dependency today has an install script or native addon (sqlite-wasm is WebAssembly). Add a CI check (`npm pack` + `npm install --ignore-scripts` succeeds and runs) to keep it so.

**Provenance and trusted publishing**

- Trusted publishing (OIDC) needs npm CLI >= 11.5.1 and Node >= 22.14.0, `permissions: id-token: write`, GitHub-hosted runners only, and `repository.url` in package.json matching the repo exactly. Provenance is generated automatically for a public repo and public package (no `--provenance` flag needed).
- The trusted publisher is configured in the package's settings on npmjs.com, so the package must exist first. Secondary sources (dev.to, WordPress handbook; not on npm's own page) say there is no "pending publisher": the **first publish is manual** (`npm login`, `npm publish --access public`), then add the trusted publisher, then set "Require 2FA and disallow tokens". A new trusted-publisher config must succeed within 2 days or it expires.
- With `workflow_dispatch`/`workflow_call` the calling workflow's filename is what npm checks.
- Our CI runs Node 22 and 24; the publish job must use >= 22.14 and npm >= 11.5.1 (Node 22 ships npm 10; run `npm i -g npm@11` or use Node 24). Not verified which npm Node 24 on the runner ships.

## 3. pub.dev release of `flutterdeck_drift`

Sources: dart.dev/tools/pub/publishing, dart.dev/tools/pub/automated-publishing, pub.dev/help/scoring.

**Current state** (`dart/flutterdeck_drift/pubspec.yaml`): `name`, `description`, `version: 0.1.0`, `publish_to: none`, `sdk: ^3.12.2`, deps drift/ffi/sqlite3. Has `LICENSE` (MIT, "project-deck contributors"), `README.md`, `analysis_options.yaml`, `pubspec.lock`, `tool/`, tests. Missing: `CHANGELOG.md`, `example/`, `repository`/`homepage`/`issue_tracker`, `topics`. `pub.dev/api/packages/flutterdeck_drift` returns 404 (name free).

**Needed**

- Remove `publish_to: none`. Add `repository: https://github.com/Thamzy265/project-deck` (pana accepts a monorepo subpath URL, e.g. `.../tree/main/dart/flutterdeck_drift`; not verified), `issue_tracker`, `topics` (up to 5).
- `CHANGELOG.md` (pub points), `example/` with an illustrative `main.dart` (pub points), >= 20% public API dartdoc, zero `dart analyze` issues against `lints`, works with latest stable SDK and deps (`dart pub outdated`). Platform detection: package depends on `ffi`/`sqlite3`, so web will show unsupported; declare `platforms:` if pana misdetects. Not verified: score until `pana` is run locally (`dart pub global activate pana`).
- `dart pub publish --dry-run` first; `.pubignore` to drop `tool/`, `test/probe` etc. if not wanted. Description length: pana's guidance is 60–180 chars (not on the pages read; from memory, not verified). Current description is ~105 chars.
- `sdk: ^3.12.2` limits users to very recent Dart; check the lowest SDK that works, since a high floor costs reach.
- Debug-only gate: the package is pure Dart and mirrors `kDebugMode` with `dart.vm.product`/`dart.vm.profile` environment checks (`lib/src/register.dart`), so pana will classify it as a Dart package, not a Flutter one. The README should state the debug-only behaviour.

**Verified publisher and automation**

- A new package can't be published straight to a publisher: publish to a Google account, then transfer (irreversible). A verified publisher needs a domain verified in Google Search Console.
- Automated publishing works only for existing packages: first version is manual (`dart pub publish`). Then on pub.dev admin: enable GitHub Actions publishing, set a tag pattern with `{{version}}` (e.g. `flutterdeck_drift-v{{version}}` suits a monorepo), optional required environment. Workflow: `on.push.tags` matching, `id-token: write`, `uses: dart-lang/setup-dart/.github/workflows/publish.yml@v1` with `working-directory: dart/flutterdeck_drift`. Publisher-owned packages are supported.

## 4. `flutterdeck doctor`

**Exists today** (`packages/cli/src/`): `prerequisites.ts` runs exactly `dart --version`, `flutter --version`, `adb version` (allowlisted, from `homedir()`, timeouts, 1 MB cap, shell only for .bat on win32), parses versions, warns if Dart < 3.9. `init` prints it. `cli.ts` has `init`, `start`, `stop`, `open`, `mcp`; **no `doctor`** (plan, "flutterdeck init" step 2, says doctor reruns the prerequisite check).

**A doctor should report (read-only, never starts or stops anything):**

1. Node version vs `engines` (>= 22.12).
2. `dart` (>= 3.9 for `dart mcp-server`), `flutter`, `adb` (reuse `checkPrerequisites`; adb found via `resolveAdbPath`).
3. Project: `pubspec.yaml` with Flutter (`flutter-project.ts`), `.flutterdeck/config.json` present, `runtime.json`/`state.json` git-ignored (`gitignore.ts`), `runtime.json` mode 0600 (skip on win32).
4. Daemon: is it running for this project (runtime.json + authenticated health call to 127.0.0.1); port.
5. DTD discovery: how many DTDs and apps are visible (same logic as `scripts/dtd-apps.mjs`, via the connector, not new DTD code).
6. Drift: whether the app depends on `drift` and `flutterdeck_drift` (pubspec read only).
7. Plugin: whether `flutterdeck@<mkt>` is enabled. Reading `~/.claude/settings.json` `enabledPlugins` is a file read; running `claude plugin list` would add a new command to the daemon's fixed list (needs a PM decision under the security rules). Not verified: a stable file location for installed plugins.
8. Dart MCP server: `dart mcp-server --help` would be a new allowlisted command; the Dart version check may be enough.
9. `.claude/launch.json` has the dashboard entry (`launch-json.ts`).

Output: one line per check, ok/warn/fail plus a fix hint; exit 1 on a fail; `--json` for CI and the smoke test. Never print the token or VM service URIs.

## 5. Smoke tests

**CI today** (`.github/workflows/ci.yml`): `check` matrix ubuntu/macos/windows × Node 22/24 runs install, build, typecheck, lint, format, test. `e2e` (Ubuntu, Playwright vs built daemon). `sample-app` and `flutterdeck-drift` (Ubuntu, Flutter 3.44.6). Nothing packs or installs a tarball, runs the `bin`, or validates the plugin.

**Needed per OS (ubuntu/macos/windows, Node 22.12 and 24)**

1. Build, then `pnpm pack` (option A: every package) or pack the bundled package (option B) into a temp dir.
2. In a fresh folder outside the workspace: `npm init -y && npm install --ignore-scripts <tarball(s)>`; fails if anything needs a native build.
3. `npx flutterdeck --version` / `--help`; `npx flutterdeck doctor --json` (no Flutter on the runner: expect "missing", exit code as designed).
4. Start the daemon in fake mode from the installed package (`node packages/daemon/dist/main.js --fake` today; the CLI has no `--fake`, check `start` args), `curl` `/api/...` with the token from `.flutterdeck/runtime.json`, fetch `/` and check the dashboard HTML and one asset load; run one `db_query` through the sql-guard worker (proves worker + wasm paths survive packing); `stop`.
5. MCP: spawn `npx -y <tarball-pkg> mcp` over stdio, `initialize` + `tools/list`. On Windows test both `npx` and `cmd /c npx` as the `.mcp.json` command (open question in section 1).
6. `claude plugin validate --strict ./plugin` (needs the Claude Code CLI on the runner; `npm i -g @anthropic-ai/claude-code`; not verified that validate works without login).
7. Separate: `dart pub publish --dry-run` and `pana` for `flutterdeck_drift` (Ubuntu).

The "fresh machine under five minutes" acceptance can't run in CI (needs Flutter + device + Claude Desktop); QA runs it by hand on a clean user account or VM, timed, README only.

## 6. Risks and open questions for the PM

1. **Name** (PM decision already pending). It decides the npm package, `bin`, plugin `name` (permanent once published), marketplace `name`, pub.dev package and `CLI_NAME` (`packages/cli/src/name.ts`). Conflict: pub.dev already has `flutter_deck` (presentations framework) with the site flutterdeck.dev. "FlutterDeck" is confusable; the marketer's shortlist should be checked on npm, pub.dev, GitHub and domains together.
2. **Accounts** (PM only): npm account with 2FA (and an npm org if scoped); Google account for pub.dev; a domain for a pub.dev verified publisher (optional, Search Console DNS); paid claude.ai plan if submitting to Anthropic's directory.
3. **First publishes are manual** on npm and pub.dev (trusted publishing needs the package to exist). The PM or a PM-run command does them; then CI takes over with OIDC. No long-lived tokens in repo secrets if possible.
4. **Package shape**: one bundled package vs 11 scoped packages (section 2). Lead recommends evaluating the bundle; PM decides if it changes the public API story.
5. **Plugin → CLI link**: `npx -y <pkg>@<pinned>` vs a CLI bundled inside the plugin. Affects start-up time, offline use and version skew.
6. **Marketplace location**: this repo (clones the whole monorepo on install) vs a small separate marketplace repo; rename of `flutterdeck-dev`; `version` in `plugin.json` (bump per release) vs SHA tracking. Submit to Anthropic's directory or not.
7. **Duplicate Dart MCP server** when the official `dart-flutter` plugin is also installed: keep bundling `dart mcp-server`, or depend on/recommend the official plugin instead. CLAUDE.md says "reuse, don't rebuild".
8. **Doctor commands**: running `claude plugin list` or `dart mcp-server` would extend the fixed command list (security rule, PM decision like 14 and 16 Oct).
9. **Dart SDK floor** `^3.12.2` for `flutterdeck_drift` may exclude many users; lowering it needs testing.
10. **Windows `npx`** in `.mcp.json` is untested.
11. **Privacy (UK + EU)**: README and pub.dev page should say the tool is local-only and debug-only; any telemetry would need a decision (none planned).
12. **Licence holder** reads "project-deck contributors" in `dart/flutterdeck_drift/LICENSE`; align with the chosen name and the root `LICENSE`.
