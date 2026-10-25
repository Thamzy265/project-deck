# M3 post text and feedback questions

> **Working name.** The product name is an open plan decision (docs/PLAN.md, "Open decisions"). Replace "FlutterDeck" before publishing.

Draft for the M3 validation checkpoint (docs/PLAN.md). The team drafts; the PM publishes and collects feedback. Nothing here is posted.

Placeholders: `[DEMO LINK]` (the 60-second video), `[REPO LINK]` (the repo or the install guide), `[FORM LINK]` (the feedback form).

## Short version (X, Bluesky, Mastodon; about 280 characters)

> Early preview: FlutterDeck shows your app's Drift database live next to Claude in Claude Desktop. Through FlutterDeck, Claude can read it but not change it. It attaches to the app your IDE runs, so breakpoints still work. Android-tested, git checkout. [DEMO LINK]

Character count without the link: about 251; with a link (23 on X) about 275. Add `[FORM LINK]` in a reply: "Feedback welcome: [FORM LINK]".

## Medium version (Reddit r/FlutterDev, Discord, Slack; about 190 words)

> **Early preview: a live Drift database inspector next to Claude in Claude Desktop**
>
> I'm building FlutterDeck, an open-source dashboard and Claude Code plugin for Flutter developers. This preview is the database part.
>
> - You run your app from your IDE or `flutter run` in debug mode, as usual. FlutterDeck attaches to it. It never launches the app, so your breakpoints still work.
> - A Database tab in Claude Desktop's Browser pane shows your Drift tables live. New rows flash as your app adds them.
> - Claude can query the database read-only: "how many orders are pending?", or "snapshot the database, I'll tap the button, then tell me what changed". Claude can't change data through FlutterDeck: its database tools refuse every query that writes. You can hide columns from these tools.
>
> It is early. You install it from a git checkout, it needs Claude Desktop and Claude Code, and we have only tested it on macOS with an Android emulator.
>
> 60-second demo: [DEMO LINK]
> Install guide: [REPO LINK]
> I'd like to hear what you think, especially if it doesn't fit how you work: [FORM LINK]

## Longer version (blog, LinkedIn; about 380 words)

> **Seeing your Flutter app's database next to Claude**
>
> When I work on a Flutter app with Claude, I often want to know what my app actually saved. Did the new order go in? Is its status right? Usually that means stopping, opening a separate tool, and copying a database file off the device.
>
> FlutterDeck is an open-source dashboard and Claude Code plugin that I am building for this. This early preview is its database inspector for Drift.
>
> **How it works.** You start your app from your IDE or `flutter run`, in debug mode, as you do today. FlutterDeck finds the running app and attaches to it. It never launches or stops your app, so your IDE stays in control and your breakpoints still hit. A small debug-only package, `flutterdeck_drift`, lets FlutterDeck read your Drift database. It does nothing in profile and release builds.
>
> **What you see.** In Claude Desktop's Browser pane, a Database tab shows your tables live. When your app adds a row, it appears in the table and flashes. You can filter and sort, see a schema diagram, run read-only SQL, take a snapshot and see what changed since.
>
> **What Claude can do.** Claude gets read-only tools for the same database. You can ask "how many orders are pending?" and get an answer from your real data. You can ask Claude to take a snapshot, make a change in the app, and then ask Claude what the change saved. Claude can't change data through FlutterDeck: its database tools refuse every query that writes. You can hide columns from these tools, for example your users' personal data.
>
> **What it is not, yet.** It is an early preview. You install it from a git checkout, not from npm or pub.dev. It needs Claude Desktop and Claude Code. We tested it on macOS with an Android emulator; Windows, Linux and iOS devices are not tested.
>
> **What I'd like from you.** I want to know if this is useful for Flutter developers before I build more. Watch the 60-second demo, try it if you can, and tell me what's missing or wrong.
>
> Demo: [DEMO LINK]
> Install guide: [REPO LINK]
> Feedback form (5 minutes): [FORM LINK]

## Feedback questions

Mix of multiple choice and open questions. About 5 minutes. Question 12 was added by the PM (via the lead) on 24 Oct 2026.

1. **How do you run your Flutter app while you develop?** (multiple choice, several allowed) Android Studio · VS Code · `flutter run` in a terminal · Other: ___
2. **Which local databases do your apps use?** (multiple choice, several allowed) Drift · sqflite · Isar · Hive · ObjectBox · Realm · None · Other: ___
3. **Which platforms do you test on most?** (multiple choice, several allowed) Android emulator · Android device · iOS simulator · iOS device · Web · Desktop
4. **Do you use Claude for app development today?** (single choice) Claude Code in Claude Desktop · Claude Code in a terminal · Claude in the browser or app · Another AI assistant · No
5. **After the demo, how useful would this be in your work?** (scale 1–5, 1 = not useful, 5 = very useful)
6. **Did you try the install guide?** (single choice) Yes, it worked · Yes, I got stuck · No, not yet · No, I won't
7. **If you got stuck, at which step, and what did you see?** (open)
8. **What would stop you from using it?** (multiple choice, several allowed) Needs a package in my app · Needs Claude Desktop · Install from a git checkout · My database isn't Drift · My platform isn't supported · Privacy or security concerns · Nothing · Other: ___
9. **FlutterDeck lets Claude read your database but not change it. Is that the right default for you?** (single choice) Yes · No, I want Claude to write with my confirmation · Not sure
10. **What is the one thing you'd want next?** (open)
11. **Anything confusing or wrong in the demo or the guide?** (open)
12. **Which task tracker do you use? Would you want your tasks shown inside FlutterDeck, or is Claude with your tracker's own MCP server enough?** (multiple choice for the tracker, several allowed: Linear · Jira · GitHub Issues · Other: ___ · None; then, unless the answer was None, an optional single choice: Show my tasks inside FlutterDeck · Claude with my tracker's own MCP server is enough · Not sure; optional comment)
13. **May we contact you about your answers?** (optional) Email: ___ (used only to reply about this feedback; see the note below)

## Form outline (paste into a form tool)

| #   | Field                                             | Type                                     | Required    | Options / notes                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------- | ---------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | Intro text                                        | Text block                               | —           | "Thanks for looking at the FlutterDeck early preview. 5 minutes, 13 questions. We use your answers only to decide what to build next. Don't paste app data, tokens or logs."                                                                                                                                   |
| 1   | How do you run your app while you develop?        | Checkboxes                               | Yes         | Android Studio; VS Code; `flutter run` in a terminal; Other (text)                                                                                                                                                                                                                                             |
| 2   | Local databases your apps use                     | Checkboxes                               | Yes         | Drift; sqflite; Isar; Hive; ObjectBox; Realm; None; Other (text)                                                                                                                                                                                                                                               |
| 3   | Platforms you test on most                        | Checkboxes                               | Yes         | Android emulator; Android device; iOS simulator; iOS device; Web; Desktop                                                                                                                                                                                                                                      |
| 4   | Claude for app development today                  | Multiple choice                          | Yes         | Claude Code in Claude Desktop; Claude Code in a terminal; Claude in the browser or app; Another AI assistant; No                                                                                                                                                                                               |
| 5   | Usefulness after the demo                         | Linear scale 1–5                         | Yes         | 1 = not useful, 5 = very useful                                                                                                                                                                                                                                                                                |
| 6   | Did you try the install guide?                    | Multiple choice                          | Yes         | Yes, it worked; Yes, I got stuck; No, not yet; No, I won't                                                                                                                                                                                                                                                     |
| 7   | Where did you get stuck?                          | Paragraph                                | No          | Show only if 6 = "Yes, I got stuck", if the tool allows. Help text: "Step number and the message you saw. Remove tokens, addresses and personal data."                                                                                                                                                         |
| 8   | What would stop you from using it?                | Checkboxes                               | Yes         | Needs a package in my app; Needs Claude Desktop; Install from a git checkout; My database isn't Drift; My platform isn't supported; Privacy or security concerns; Nothing; Other (text)                                                                                                                        |
| 9   | Claude reads, doesn't change: right default?      | Multiple choice                          | Yes         | Yes; No, I want Claude to write with my confirmation; Not sure                                                                                                                                                                                                                                                 |
| 10  | The one thing you'd want next                     | Short answer                             | No          |                                                                                                                                                                                                                                                                                                                |
| 11  | Confusing or wrong in demo or guide               | Paragraph                                | No          |                                                                                                                                                                                                                                                                                                                |
| 12  | Task tracker, and tasks inside FlutterDeck or not | Checkboxes + multiple choice + paragraph | Part a only | Part a, checkboxes: Linear; Jira; GitHub Issues; Other (text); None. Part b, optional, multiple choice (show only if part a is not "None", if the tool allows): Show my tasks inside FlutterDeck; Claude with my tracker's own MCP server is enough; Not sure. Part c, paragraph, optional: "Anything to add?" |
| 13  | Contact email                                     | Short answer (email)                     | No          | Help text: "Optional. Only to reply about your feedback. We delete it when the feedback round ends." Needs the PM's privacy wording (see open questions).                                                                                                                                                      |

Privacy note for the PM: the form collects no personal data except the optional email in field 13. The privacy regions are UK and EU, so the email field needs a short privacy notice (who holds it, why, how long, how to ask for deletion) before the form goes live. Turn off email collection and sign-in in the form tool's settings, so the tool doesn't record who answered. Without that notice, remove field 13.

## Open questions for the PM

1. Product name (open decision in docs/PLAN.md): every "FlutterDeck" in these texts.
2. Where to post: r/FlutterDev, the Flutter Discord, Flutter community Slack, X, Bluesky, Mastodon, LinkedIn, a blog? Some subreddits and servers have self-promotion rules; check them before posting.
3. Voice: the texts say "I". Change to "we" if the post comes from a project account.
4. Repo visibility and link: `[REPO LINK]` points to the public repo `Thamzy265/project-deck` or the install guide in it? The README still says "Nothing is installable yet".
5. Licence wording: say "open source (MIT)" in the posts? The texts say "open-source" only.
6. Show or mention iOS? The texts say iOS devices are not tested and leave the iOS simulator out.
7. Form tool, and who holds the answers (privacy notice for field 13).
8. Mention the Drift DevTools extension? The texts make no comparison, because we have no evidence for one.

## Claims in this draft

| #   | Claim (as written)                                                                                                                                   | Evidence (docs/qa/... section, or "none")                                                                                                                            | QA verdict                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | Shows your Drift database live in Claude Desktop (Browser pane, Database tab)                                                                        | qa/M3.md batch 4 C (live Drift, real Android); "PM check (batch 4)" in the Browser pane                                                                              | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 2   | Through FlutterDeck, Claude can read but not change data; its database tools refuse every query that writes                                          | qa/M3.md batch 5 B3, D4; "M3 acceptance" step 12 (PM)                                                                                                                | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 3   | It attaches to the app you run from your IDE; never launches or stops your app                                                                       | qa/M3.md "IDE breakpoint check" step 4 and "PM run (2026-10-24)"; qa/M1.md acceptance. "Never stops": none beyond the design rule and M1 checks                      | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 4   | Breakpoints still work / still hit                                                                                                                   | qa/M3.md "IDE breakpoint check", "PM run (2026-10-24)"                                                                                                               | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 5   | Android-tested; tested on macOS with an Android emulator                                                                                             | qa/M3.md batches 2–5, "IDE breakpoint check"                                                                                                                         | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 6   | From a git checkout; not on npm or pub.dev                                                                                                           | docs/PLAN.md M5 (npm and pub.dev are M5); no qa evidence needed                                                                                                      | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 7   | Works from your IDE or `flutter run`                                                                                                                 | Android Studio: qa/M3.md "PM run (2026-10-24)". `flutter run`: qa/M3.md batches 2–5. VS Code: qa/M2.md "Final PM check" (IDE named as either); M3 with VS Code: none | reword — docs/qa/M3.md#claim-check-validation-drafts   |
| 8   | New rows flash as your app adds them                                                                                                                 | qa/M3.md batch 4 C R2                                                                                                                                                | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 9   | Filter, sort, schema diagram, read-only SQL, snapshot and diff in the Database tab                                                                   | qa/M3.md batch 4 B steps 6–10, C R7–R8                                                                                                                               | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 10  | "How many orders are pending?" answered from real data                                                                                               | qa/M3.md "PM run (2026-10-24)" step 7 (real sample app); "M3 acceptance" (fake mode)                                                                                 | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 11  | Claude takes a snapshot, you change something, Claude says what the change saved                                                                     | qa/M3.md "M3 acceptance" step 11 (PM, fake mode); batch 5 D3 (real Android, without Claude). Real app with real Claude: none                                         | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 12  | You can hide columns from FlutterDeck's tools                                                                                                        | qa/M3.md batch 5 B2; batch 4 C R3                                                                                                                                    | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 13  | `flutterdeck_drift` is debug-only; does nothing in profile and release builds                                                                        | qa/M3.md batch 2 row 7 (profile). Release: none (not built)                                                                                                          | reword — docs/qa/M3.md#claim-check-validation-drafts   |
| 14  | Needs Claude Desktop and Claude Code                                                                                                                 | qa/M3.md "PM check (IDE breakpoint)" prerequisites                                                                                                                   | reword — docs/qa/M3.md#claim-check-validation-drafts   |
| 15  | Windows, Linux and iOS devices are not tested                                                                                                        | qa/M2.md batch 2 "Not observed" (Windows and Linux not run); no iOS device run in qa/M3.md                                                                           | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 16  | Open-source                                                                                                                                          | none in qa (LICENSE file: MIT; docs/PLAN.md "Licence" decided 9 Oct 2026)                                                                                            | verified — docs/qa/M3.md#claim-check-validation-drafts |
| 17  | Feedback form takes about 5 minutes                                                                                                                  | none (estimate)                                                                                                                                                      | reword — docs/qa/M3.md#claim-check-validation-drafts   |
| 18  | The "can't change data" and hidden-column claims are scoped to FlutterDeck's tools; Claude Code's shell, file and Browser pane tools are not covered | docs/status.md, risks accepted by the PM 2026-10-16 (Bash) and 2026-10-17 (Browser pane); not a qa claim                                                             | verified — docs/qa/M3.md#claim-check-validation-drafts |
