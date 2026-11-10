# M5 Packaging and public release — design note

Date: 2026-11-10 — Size: large — new outside services (npm, pub.dev, the Claude Code plugin marketplace), a new trust boundary (our published packages run on users' machines), and a project rename — Phase: MVP (this milestone ends it) — Status: draft, waiting for PM

## Context

M1–M4 are on `main`. Today the product runs only from a clone of this repo: the plugin's `.mcp.json` starts `${CLAUDE_PLUGIN_ROOT}/../packages/cli/dist/main.js`, nothing is on npm or pub.dev, and the only marketplace is the dev one, `flutterdeck-dev`. M5 makes it installable by anyone ([PLAN.md, M5](../PLAN.md#m5--packaging-and-public-release)). Facts checked on 10 Nov 2026 are in [notes/m5-release.md](../notes/m5-release.md).

PM decisions so far (10 Nov 2026, [status.md](../status.md)): M5 runs beside the open M3 validation checkpoint; the product is renamed **Pitdeck** ([shortlist](../marketing/name-shortlist.md)); the PM checks trademark registers and domains before anything is published.

## Requirements and non-goals

- Functional:
  - Rename FlutterDeck to Pitdeck everywhere a user sees it: CLI command `pitdeck`, project folder `.pitdeck/`, Dart package `pitdeck_drift`, plugin `pitdeck`, docs.
  - One install path from the README: add the marketplace and install the plugin in Claude Code; the plugin starts the CLI from npm; `pitdeck init` in the Flutter project; add `pitdeck_drift` for the live inspector.
  - npm release of the CLI; pub.dev release of `pitdeck_drift`; a public marketplace entry.
  - `pitdeck doctor`: read-only checks with a fix hint for each problem.
  - Smoke tests on Windows, macOS and Linux that install the packed package, not the workspace.
  - README with a demo GIF, `ADAPTERS.md`, `CONTRIBUTING.md`, MIT licence.
- Non-functional: no native Node modules (`npm install --ignore-scripts` works); the plugin pins one CLI version; publishing needs no long-lived token in the repo; nothing leaves the user's machine (no telemetry).
- Non-goals: submitting to Anthropic's plugin directory; a website or domain; Homebrew; auto-update; Compose, web or task-tracker adapters (interfaces only, per v1 scope).

## Top 3 qualities

| Quality                 | Target                                                                                                                  | How we check it                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Time to first dashboard | A fresh machine with Flutter reaches a working dashboard in under 5 minutes using only the README                       | QA, timed, on a clean user account (needs a device or emulator)                             |
| Installs everywhere     | Packed package installs with `--ignore-scripts` and runs on Windows, macOS, Linux, Node 22.12 and 24                    | New CI smoke job per OS                                                                     |
| Supply-chain safety     | Every published version has npm provenance; no publish token stored in the repo; the plugin runs one pinned CLI version | Release workflow review; `npm view pitdeck --json` shows provenance; reviewer security pass |

## Estimate

Trivially small: one CLI download per user per version (about 4–5 MB with the dashboard and sqlite-wasm), no servers of ours.

## Data

n/a — no new stored data. The rename moves the project folder from `.flutterdeck/` to `.pitdeck/` (runtime token, state, config). Released users never had `.flutterdeck/`, so there is no migration; `doctor` warns if an old `.flutterdeck/` folder is found (dev machines only).

## Options

### Package shape (decision D1)

**A: one bundled package `pitdeck` (recommended).** Bundle the CLI and our internal packages with esbuild/tsup into one unscoped package. Copy in the dashboard's built files, the two worker entry points and the sqlite-wasm file; keep a few pure-JS dependencies external. Benefits: `npx pitdeck` works and owns its name (no squatting gap); smallest download (no React or CodeMirror sources); our internal APIs stay private; one version. Costs: a bundling step and path fixes for assets and workers; needs the tarball smoke test to prove paths survive. Effort: medium.

**B: publish all 11 `@project-deck/*` packages.** `pnpm publish -r` as they are. Benefits: no bundler, asset paths unchanged. Costs: needs the `@project-deck` npm org; 11 public packages to version together; `npx` downloads the dashboard's React tree; the bin name `pitdeck` would not match the package, so `npx pitdeck` would fetch someone else's package unless we also claim `pitdeck`. Effort: low to start, more to maintain.

### How the plugin starts the CLI (decision D2)

**A: `npx -y pitdeck@<exact version> mcp` (recommended).** Plugin and CLI release together; each plugin version names one CLI version. Costs: first start downloads the CLI (npm caches it after); needs network once; Windows may need `cmd /c npx` (smoke test decides).

**B: ship the bundled CLI inside the plugin.** `node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js mcp`. No download at start and works offline; costs a build artifact committed to the repo or a release branch, and two copies of the CLI (plugin and npm) to keep equal.

## Decision

Waiting for PM: D1 and D2 (recommend A and A), plus D3–D7 below. ADRs once decided: [0006](../adr/0006-single-bundled-npm-package.md) (package shape), [0007](../adr/0007-plugin-runs-pinned-npx.md) (plugin to CLI). Both are hard to reverse once users install them.

Other decisions for the PM:

- **D3 Marketplace location:** this repo's `.claude-plugin/marketplace.json`, renamed to `pitdeck` (recommended: one repo, one tag per release) vs a small separate marketplace repo (faster install, two repos). Install clones the whole monorepo either way unless a `git-subdir` source is used; we use `git-subdir` pointing at `plugin/`.
- **D4 Dart MCP server:** keep bundling `dart mcp-server` in our plugin (recommended: works with no other setup) vs tell users to install Google's `dart-flutter` plugin. Users with both get two Dart servers; `doctor` warns and the README explains how to turn ours off.
- **D5 `doctor` and new commands:** read files only (recommended: `~/.claude/settings.json` for the plugin, `dart --version` for the MCP server) vs add `claude plugin list` and `dart mcp-server --help` to the fixed command list (a security-rule change, PM decision).
- **D6 Dart SDK floor for `pitdeck_drift`:** test and lower to the oldest Dart that works with our Drift version (recommended: reach more users) vs keep `^3.12.2`.
- **D7 First version number:** `0.1.0` on npm, pub.dev and the plugin (recommended: says "early") vs `1.0.0`.
- **PM tasks (only the PM can do them):** trademark and domain check for "Pitdeck"; npm account with 2FA; Google account for pub.dev; the first manual publish on npm and on pub.dev (trusted publishing needs the package to exist); approve each release.

## Failure plan

- `npx` start fails (offline, registry down): Claude Code shows the MCP server failed; README and `doctor` say to run `npx -y pitdeck@<version> --version` once online. No retry loop.
- Every outbound call in new code is a fixed local command with the existing timeouts and byte caps (`prerequisites.ts`, `android-adb`). `doctor`'s daemon check uses the existing authenticated loopback health call with its timeout. No new network calls.
- Release workflow fails half-way (npm published, pub.dev not): each publish is its own job keyed by tag; re-running publishes only what is missing; npm versions are never reused (bump to the next patch).

## Observability

`pitdeck doctor` (and `--json`) is the health check users run and paste into issues. It never prints the token, auth codes or VM service URIs. No telemetry.

## Trust boundaries and abuse cases

- Boundaries: the npm registry and pub.dev (users' machines run what we publish); the GitHub repo as the marketplace (plugin updates); the release workflow's OIDC identity; `doctor` reading local config files.
- Abuse cases:
  - "As an attacker I publish `pitdeck` on npm before we do, so that the README's `npx pitdeck` runs my code" — mitigation: the PM's first manual publish claims `pitdeck` (and `pitdeck_drift`) early in M5, right after the trademark check; the plugin pins an exact version.
  - "As an attacker I steal a publish token, so that I can push a malicious version" — mitigation: trusted publishing (OIDC) from one workflow file on a protected tag; npm "require 2FA and disallow tokens" after the first publish; provenance on every version.
  - "As an attacker I change the repo so that existing users get a malicious plugin update" — mitigation: auto-update is off by default for third-party marketplaces; the plugin pins the CLI version; `main` is protected and changes merge through reviewed PRs.
  - "As an attacker I get `doctor` to run a command of my choice through a crafted config" — mitigation: `doctor` only reads files and runs the existing fixed commands with validated arguments.
  - "As an attacker I hide an install script in a dependency" — mitigation: the smoke test installs with `--ignore-scripts` and fails on native builds; dependency check (`pnpm audit`) in the release workflow.

## Privacy

Not legal advice. The release adds no personal data processing by us: nothing is sent to us or any service of ours.

| Field    | Purpose | Lawful basis (PM decides)         | Retention | Shared with | Notes                                                        |
| -------- | ------- | --------------------------------- | --------- | ----------- | ------------------------------------------------------------ |
| none new | —       | n/a — we process no personal data | —         | none        | App logs and Drift rows stay on the user's machine, as today |

- Fields removed: none.
- DPIA screening: none of the ICO triggers hit — not needed because we receive no data.
- Children likely: no — developer tool.
- Automated decisions or profiling: none. Special category data: none.
- New vendors / SDKs / transfers: npm and pub.dev host our packages (public code, no user data). Registries see users' download requests under their own terms; we receive nothing.
- Private defaults: unchanged — loopback only, token required, read-only database access, `pitdeck_drift` debug builds only.
- Export, delete, rectify: n/a — we hold nothing. README says how to remove `.pitdeck/` and the plugin.
- Record of processing and privacy notice: the README and the pub.dev page state "local only, no telemetry, debug builds only". This is a public privacy claim, so the wording goes to QA's claim check and the PM.
- Escalated to PM: the public privacy wording in the README.

## Rollout and rollback

Batches, each through developer → tester → reviewer → QA → CI → merge:

1. **Rename** to Pitdeck (CLI name, folder, Dart package, plugin, docs, tests). No behaviour change.
2. **npm package** per D1, plus the CI tarball smoke job on three OSes.
3. **Plugin for release** per D2/D3: `.mcp.json` via the pinned CLI, public marketplace, `plugin.json` metadata, `claude plugin validate --strict` in CI, `init` prints the public install commands.
4. **`pitdeck doctor`** per D5.
5. **`pitdeck_drift` for pub.dev:** pubspec fields, CHANGELOG, example, SDK floor per D6, `pana` and `dart pub publish --dry-run` in CI.
6. **Docs:** README with demo GIF, `ADAPTERS.md`, `CONTRIBUTING.md`, licence holder aligned; marketer drafts, QA claim check.
7. **Release workflow** (trusted publishing, provenance, tags), release notes, then the PM's first manual publishes and the timed fresh-machine acceptance.

Rollback: `npm deprecate pitdeck@<bad>` and publish the next patch (npm unpublish only within 72 hours and is a last resort); pub.dev: retract the version; plugin: bump `version` back to the last good CLI pin in a new commit. Confirm by installing from the README on a clean account.

## Later lines

- Submit to Anthropic's plugin directory — needs a paid plan and extra review; not needed to install from GitHub — trigger: 50 GitHub stars or 3 user requests — noted 2026-11-10 by lead
- Ship the CLI inside the plugin for offline use — trigger: 3 issues about `npx` start-up or offline use — noted 2026-11-10 by lead
- Homebrew formula — trigger: 3 user requests — noted 2026-11-10 by lead
- Verified publisher on pub.dev (needs a domain) — trigger: a second Dart package, or the PM buys a domain — noted 2026-11-10 by lead
