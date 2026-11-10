# Brand voice

Status: draft for the PM to approve (10 Nov 2026). No release copy is written from this file until the PM approves it. The earlier M3 drafts in this folder predate it; the marketer re-checks them against it after approval.

The product was called "FlutterDeck" until the PM renamed it Pitdeck (10 Nov 2026; the shortlist is in `name-shortlist.md`). This file says "the product" so it survives a rename.

## Audience

- **Who:** Flutter developers who already use Claude Code, mostly in Claude Desktop. They start their app from Android Studio, VS Code or `flutter run` and care that their breakpoints keep working.
- **What they know:** Flutter, Dart, often Drift. They know what hot reload, DTD and an MCP server are. They don't need those explained, and they don't want a pitch.
- **What they worry about:** a tool that takes over their app, a tool that lets an AI write to their database, and a tool that sends their data somewhere. Our copy answers these openly.
- **Region:** UK and EU. Their users' data is personal data, so we treat privacy statements with care.

## Tone

- Plain, calm, specific. One developer talking to another.
- Honest about the stage. This is an early, MVP-phase project: say what works, what was tested and what was not.
- Short sentences, concrete nouns. Show what you see on screen or what Claude can do, in one example.
- No hype, no exclamation marks, no emoji.
- British spelling (behaviour, licence, colour).
- "I" when one person posts, "we" when the project account posts. The PM chooses (open question in `m3-post.md`).

## Words we use

- **attach** (to a running app), **running app**, **debug mode**
- **read-only through Pitdeck's tools**, when we describe Claude and the database
- **early preview**, **installs from a git checkout** (until npm and pub.dev are live)
- **tested on** plus the exact setup (for example "macOS, Android emulator")
- **open source (MIT)**
- Product terms: Database tab, Browser pane, snapshot, Drift, DTD, breakpoint

## Words we avoid

- **launch, start your app** as something the product does. It never launches or stops the app.
- **seamless, effortless, supercharge, revolutionary, game-changing, blazing fast, magic**
- **better than, replaces, the best** about the Drift DevTools extension or any tool. The plan aims for "clearly better", but we have no evidence yet. Say what ours does.
- **secure, safe, private, production-ready** on their own. Say the specific, checked fact instead, such as "its database tools refuse every query that writes".
- **works everywhere, cross-platform.** Name the platforms we tested.
- **official, certified, by Google, for Flutter** in a way that suggests Google or the Flutter team made or endorses it. Flutter and Dart are Google trademarks. Use "for Flutter developers" or "works with Flutter apps", not "Flutter" inside a logo or lockup. The name decision is covered in `name-shortlist.md`.
- User counts, stars, "loved by", "trusted by", benchmarks and speed numbers, unless a source exists.

## Claims rules

1. Every factual claim traces to QA evidence (`docs/qa/<milestone>.md#<row>`) or a cited source. If it does not, reword it until it is true, or leave it out.
2. Describe only features marked PASS in the QA evidence. Everything else goes under "Not included" in the draft.
3. Scope the safety claims. "Claude can't change data" always means "through Pitdeck's tools". Claude Code's own shell, file and Browser pane tools are not covered (risks accepted by the PM, `docs/status.md`).
4. Say what was tested and what was not: macOS with an Android emulator is tested. Windows, Linux and iOS devices are not.
5. No comparison with another tool without evidence QA has verified.
6. No promise about the future (roadmap items, dates) in launch copy. Plans live in `docs/PLAN.md`.
7. Every draft has a claims table (`Claim | Source/evidence | QA verdict`). QA checks it, through the lead, before the PM sees the draft.
8. Screenshots come only from QA's committed screenshots with synthetic data. Never show tokens, VM service URIs or real app data.
9. The marketer drafts. The PM publishes. Nothing is posted, scheduled or sent by the team.

## Example sentences

Each one traces to a verified claim in `m3-post.md` (claims 1, 3, 4 and 2, 18).

- "Your Drift tables show up live in Claude Desktop's Browser pane, and new rows flash as your app adds them."
- "It attaches to the app your IDE already runs, so your breakpoints still hit."
- "Through Pitdeck, Claude can read your database but not change it: its database tools refuse every query that writes."
