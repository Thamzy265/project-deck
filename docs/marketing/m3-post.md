# M3 post text and feedback questions

> **Name.** The PM keeps "FlutterDeck" for the validation post (PM decision, 2026-10-25). The name stays an open decision before M5 (docs/PLAN.md, "Open decisions").

Draft for the M3 validation checkpoint (docs/PLAN.md). The team drafts; the PM publishes and collects feedback. Nothing here is posted. The PM said they might post on LinkedIn (2026-10-25), so the long version is the LinkedIn post. The short and medium versions are optional, for other places.

Placeholders: `[DEMO LINK]` (the 60-second video), `[REPO LINK]` (the repo, whose README links the install guide), `[FEEDBACK LINK]` (the GitHub Discussions thread; the text is in [feedback-discussion.md](feedback-discussion.md)).

## Short version (optional: X, Bluesky, Mastodon; about 280 characters)

> Early preview: FlutterDeck (open source, MIT) shows your app's Drift database live next to Claude in Claude Desktop. Through FlutterDeck, Claude can read it but not change it. It attaches to the app your IDE runs, so breakpoints still work. Tested on Android and the iOS Simulator. [DEMO LINK]

Character count without the link: about 281; with a link (23 on X) about 305, which is over 280 on X. Cut "(open source, MIT)" and "Claude Desktop" there, or move them to the reply. Add `[FEEDBACK LINK]` in a reply: "Feedback welcome: [FEEDBACK LINK]".

## Medium version (optional: Reddit r/FlutterDev, Discord, Slack; about 190 words)

> **Early preview: a live Drift database inspector next to Claude in Claude Desktop**
>
> I'm building FlutterDeck, an open source (MIT) dashboard and Claude Code plugin for Flutter developers. This preview is the database part.
>
> - You run your app from Android Studio or `flutter run` in debug mode, as usual. FlutterDeck attaches to it. It never launches the app, so your breakpoints still work.
> - A Database tab in Claude Desktop's Browser pane shows your Drift tables live. New rows flash as your app adds them.
> - Claude can query the database read-only: "how many orders are pending?", or "snapshot the database, I'll tap the button, then tell me what changed". Claude can't change data through FlutterDeck: its database tools refuse every query that writes. You can hide columns from these tools.
>
> It is early. You install it from a git checkout. It is built for Claude Desktop's Browser pane and works with Claude Code. It is tested on Android (emulator) and the iOS Simulator; real iPhones are untested. Windows and Linux are not tested.
>
> 60-second demo: [DEMO LINK]
> Install guide: [REPO LINK]
> I'd like to hear what you think, especially if it doesn't fit how you work (replies are public, on GitHub Discussions): [FEEDBACK LINK]

## Longer version: the LinkedIn post (about 380 words; also fits a blog)

> **Seeing your Flutter app's database next to Claude**
>
> When I work on a Flutter app with Claude, I often want to know what my app actually saved. Did the new order go in? Is its status right? Usually that means stopping, opening a separate tool, and copying a database file off the device.
>
> FlutterDeck is an open source (MIT) dashboard and Claude Code plugin that I am building for this. This early preview is its database inspector for Drift.
>
> **How it works.** You start your app from Android Studio or `flutter run`, in debug mode, as you do today. FlutterDeck finds the running app and attaches to it. It never launches or stops your app, so your IDE stays in control and your breakpoints still hit. A small debug-only package, `flutterdeck_drift`, lets FlutterDeck read your Drift database. It is debug-only: we checked that a profile build doesn't include it, and we haven't built a release build yet.
>
> **What you see.** In Claude Desktop's Browser pane, a Database tab shows your tables live. When your app adds a row, it appears in the table and flashes. You can filter and sort, see a schema diagram, run read-only SQL, take a snapshot and see what changed since.
>
> **What Claude can do.** Claude gets read-only tools for the same database. You can ask "how many orders are pending?" and get an answer from your real data. You can ask Claude to take a snapshot, make a change in the app, and then ask Claude what the change saved. Claude can't change data through FlutterDeck: its database tools refuse every query that writes. You can hide columns from these tools, for example your users' personal data.
>
> **What it is not, yet.** It is an early preview. You install it from a git checkout, not from npm or pub.dev. It is built for Claude Desktop's Browser pane and works with Claude Code. It is tested on Android (emulator) and the iOS Simulator; real iPhones are untested. Windows and Linux are not tested.
>
> **What I'd like from you.** I want to know if this is useful for Flutter developers before I build more. Watch the 60-second demo, try it if you can, and tell me what's missing or wrong.
>
> Demo: [DEMO LINK]
> Install guide: [REPO LINK]
> Feedback (12 questions, public replies on GitHub Discussions): [FEEDBACK LINK]

## Feedback questions

Feedback goes to a GitHub Discussions thread on the repo (PM decision, 2026-10-25). It is public, tied to GitHub accounts, with no email field and no extra service. The thread title and body are in [feedback-discussion.md](feedback-discussion.md), with the 12 questions below numbered so people can answer "3: b". Question 12 was added by the PM (via the lead) on 24 Oct 2026. The old question 13 (contact email) is gone: replies are on GitHub, so people can be answered there.

1. **How do you run your Flutter app while you develop?** (several allowed) Android Studio · VS Code · `flutter run` in a terminal · Other
2. **Which local databases do your apps use?** (several allowed) Drift · sqflite · Isar · Hive · ObjectBox · Realm · None · Other
3. **Which platforms do you test on most?** (several allowed) Android emulator · Android device · iOS simulator · iOS device · Web · Desktop
4. **Do you use Claude for app development today?** (one) Claude Code in Claude Desktop · Claude Code in a terminal · Claude in the browser or app · Another AI assistant · No
5. **After the demo, how useful would this be in your work?** (1–5, 1 = not useful, 5 = very useful)
6. **Did you try the install guide?** (one) Yes, it worked · Yes, I got stuck · No, not yet · No, I won't
7. **If you got stuck, at which step, and what did you see?** (open)
8. **What would stop you from using it?** (several allowed) Needs a package in my app · Needs Claude Desktop · Install from a git checkout · My database isn't Drift · My platform isn't supported · Privacy or security concerns · Nothing · Other
9. **FlutterDeck lets Claude read your database but not change it. Is that the right default for you?** (one) Yes · No, I want Claude to write with my confirmation · Not sure
10. **What is the one thing you'd want next?** (open)
11. **Anything confusing or wrong in the demo or the guide?** (open)
12. **Which task tracker do you use? Would you want your tasks shown inside FlutterDeck, or is Claude with your tracker's own MCP server enough?** (tracker, several allowed: Linear · Jira · GitHub Issues · Other · None; then, unless None, one of: Show my tasks inside FlutterDeck · Claude with my tracker's own MCP server is enough · Not sure; optional comment)

## Open questions for the PM

1. Voice: the texts say "I". That fits a personal LinkedIn post. Change to "we" if the post comes from a project account.
2. Mention the Drift DevTools extension? The texts make no comparison, because we have no evidence for one.
3. The GitHub Discussions thread needs Discussions switched on for the repo and the thread created. The lead or the PM does that; the thread URL is `[FEEDBACK LINK]`.

## Claims in this draft

| #   | Claim (as written)                                                                                                                                   | Evidence (docs/qa/... section, or "none")                                                                                                                            | QA verdict                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | Shows your Drift database live in Claude Desktop (Browser pane, Database tab)                                                                        | qa/M3.md batch 4 C (live Drift, real Android); "PM check (batch 4)" in the Browser pane                                                                              | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 2   | Through FlutterDeck, Claude can read but not change data; its database tools refuse every query that writes                                          | qa/M3.md batch 5 B3, D4; "M3 acceptance" step 12 (PM)                                                                                                                | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 3   | It attaches to the app you run from your IDE; never launches or stops your app                                                                       | qa/M3.md "IDE breakpoint check" step 4 and "PM run (2026-10-24)"; qa/M1.md acceptance. "Never stops": none beyond the design rule and M1 checks                      | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 4   | Breakpoints still work / still hit                                                                                                                   | qa/M3.md "IDE breakpoint check", "PM run (2026-10-24)"                                                                                                               | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 5   | Tested on macOS with an Android emulator (QA)                                                                                                        | qa/M3.md batches 2–5, "IDE breakpoint check"                                                                                                                         | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 6   | From a git checkout; not on npm or pub.dev                                                                                                           | docs/PLAN.md M5 (npm and pub.dev are M5); no qa evidence needed                                                                                                      | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 7   | Works from Android Studio or `flutter run`                                                                                                           | Android Studio: qa/M3.md "PM run (2026-10-24)". `flutter run`: qa/M3.md batches 2–5. VS Code: qa/M2.md "Final PM check" (IDE named as either); M3 with VS Code: none | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 8   | New rows flash as your app adds them                                                                                                                 | qa/M3.md batch 4 C R2                                                                                                                                                | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 9   | Filter, sort, schema diagram, read-only SQL, snapshot and diff in the Database tab                                                                   | qa/M3.md batch 4 B steps 6–10, C R7–R8                                                                                                                               | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 10  | "How many orders are pending?" answered from real data                                                                                               | qa/M3.md "PM run (2026-10-24)" step 7 (real sample app); "M3 acceptance" (fake mode)                                                                                 | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 11  | Claude takes a snapshot, you change something, Claude says what the change saved                                                                     | qa/M3.md "M3 acceptance" step 11 (PM, fake mode); batch 5 D3 (real Android, without Claude). Real app with real Claude: none                                         | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 12  | You can hide columns from FlutterDeck's tools                                                                                                        | qa/M3.md batch 5 B2; batch 4 C R3                                                                                                                                    | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 13  | `flutterdeck_drift` is debug-only; a profile build was checked; release was not built                                                                | qa/M3.md batch 2 row 7 (profile). Release: none (not built)                                                                                                          | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 14  | Built for Claude Desktop's Browser pane; works with Claude Code                                                                                      | qa/M3.md "PM check (IDE breakpoint)" prerequisites                                                                                                                   | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 15  | Windows and Linux are not tested                                                                                                                     | qa/M2.md batch 2 "Not observed" (Windows and Linux not run)                                                                                                          | verified — docs/qa/M3.md#readme-and-wiki-2026-10-25    |
| 16  | Open source (MIT)                                                                                                                                    | LICENSE file (MIT); docs/PLAN.md "Licence" decided 9 Oct 2026; PM decision 2026-10-25                                                                                | verified — docs/qa/M3.md#readme-and-wiki-2026-10-25    |
| 17  | The feedback thread has 12 numbered questions, public replies on GitHub Discussions                                                                  | docs/marketing/feedback-discussion.md; PM decision 2026-10-25                                                                                                        | verified — docs/qa/M3.md#readme-and-wiki-2026-10-25    |
| 18  | The "can't change data" and hidden-column claims are scoped to FlutterDeck's tools; Claude Code's shell, file and Browser pane tools are not covered | docs/status.md, risks accepted by the PM 2026-10-16 (Bash) and 2026-10-17 (Browser pane); not a qa claim                                                             | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 19  | Tested on Android (emulator) and the iOS Simulator; real iPhones are untested                                                                        | Android: qa/M3.md batches 2–5. iOS: docs/qa/M3.md, PM report: iOS Simulator (2026-10-25)                                                                             | verified — docs/qa/M3.md#readme-and-wiki-2026-10-25    |
