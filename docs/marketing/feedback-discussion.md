# Feedback discussion (GitHub Discussions)

Draft for the M3 validation checkpoint (docs/PLAN.md). PM decision, 2026-10-25: feedback goes to a GitHub Discussions thread on the repo. It is public and tied to GitHub accounts. There is no email field and no extra service. Nothing here is posted: the lead or the PM turns on Discussions for the repo, creates the thread with the text below, and puts its URL in `[FEEDBACK LINK]` (see [m3-post.md](m3-post.md)).

Suggested category: a Q&A or General category. Pin the thread.

## Title

FlutterDeck early preview: feedback wanted (12 short questions)

## Body

Thanks for looking at the FlutterDeck early preview. FlutterDeck is an open source (MIT) dashboard and Claude Code plugin for Flutter developers. This preview shows your app's Drift database next to Claude in Claude Desktop. I want to know if it is useful before I build more.

Watch the 60-second demo: [DEMO LINK]. Try the install guide if you can: [REPO LINK].

**How to answer.** Reply to this thread. Number your answers like the questions, for example `3: b, d`. Skip any question. Question 5 is a number from 1 to 5. The open questions (7, 10, 11) take free text.

**Replies are public.** Everyone can read them, and they are tied to your GitHub account. Do not paste app data, database rows, logs, tokens, VM service or web addresses (URLs) or personal data. If you got stuck, give the step number and the message you saw, with tokens and addresses removed. If you post something by mistake, edit or delete your reply (the … menu on your comment).

### Questions

1. **How do you run your Flutter app while you develop?** (pick all that apply)
   a. Android Studio b. VS Code c. `flutter run` in a terminal d. Other (say what)
2. **Which local databases do your apps use?** (pick all that apply)
   a. Drift b. sqflite c. Isar d. Hive e. ObjectBox f. Realm g. None h. Other (say what)
3. **Which platforms do you test on most?** (pick all that apply)
   a. Android emulator b. Android device c. iOS simulator d. iOS device e. Web f. Desktop
4. **Do you use Claude for app development today?** (pick one)
   a. Claude Code in Claude Desktop b. Claude Code in a terminal c. Claude in the browser or app d. Another AI assistant e. No
5. **After the demo, how useful would this be in your work?** (1 = not useful, 5 = very useful)
6. **Did you try the install guide?** (pick one)
   a. Yes, it worked b. Yes, I got stuck c. No, not yet d. No, I won't
7. **If you got stuck, at which step, and what did you see?** (free text, no tokens or addresses)
8. **What would stop you from using it?** (pick all that apply)
   a. Needs a package in my app b. Needs Claude Desktop c. Install from a git checkout d. My database isn't Drift e. My platform isn't supported f. Privacy or security concerns g. Nothing h. Other (say what)
9. **FlutterDeck lets Claude read your database but not change it. Is that the right default for you?** (pick one)
   a. Yes b. No, I want Claude to write with my confirmation c. Not sure
10. **What is the one thing you'd want next?** (free text)
11. **Is anything confusing or wrong in the demo or the guide?** (free text)
12. **Which task tracker do you use?** (pick all that apply)
    a. Linear b. Jira c. GitHub Issues d. Other (say what) e. None

    If you picked a tracker: **would you want your tasks shown inside FlutterDeck, or is Claude with your tracker's own MCP server enough?** (pick one)
    f. Show my tasks inside FlutterDeck g. Claude with my tracker's own MCP server is enough h. Not sure

    Add a comment if you like.

Thank you.

## Claims in this draft

| #   | Claim (as written)                                                           | Evidence                                    | QA verdict                                          |
| --- | ---------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------- |
| 1   | Replies are public and tied to GitHub accounts; no email or other service    | PM decision 2026-10-25 (GitHub Discussions) | verified — docs/qa/M3.md#readme-and-wiki-2026-10-25 |
| 2   | FlutterDeck is an open source (MIT) dashboard and Claude Code plugin         | LICENSE file (MIT); PM decision 2026-10-25  | verified — docs/qa/M3.md#readme-and-wiki-2026-10-25 |
| 3   | The preview shows your app's Drift database next to Claude in Claude Desktop | qa/M3.md batch 4 C; "PM check (batch 4)"    | verified — docs/qa/M3.md#readme-and-wiki-2026-10-25 |
