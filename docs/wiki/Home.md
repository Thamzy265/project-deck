> The repo copy in `docs/` is the source. The wiki is published from `docs/wiki/`. Change the page in the repo, not here.

# FlutterDeck

FlutterDeck is an open source (MIT) dashboard and Claude Code plugin for Flutter developers. This early preview puts your Flutter app's Drift database next to Claude in Claude Desktop.

- You see your Drift tables live in a Database tab in Claude Desktop's Browser pane.
- Claude can read the database to answer questions. Through FlutterDeck, Claude can't change data: its database tools refuse every query that writes. You can hide columns from these tools.
- It attaches to the app you already run from your IDE or `flutter run`, in debug mode. It never launches the app, so your breakpoints still work.
- It gives Claude your app's logs, and works with the official Dart MCP server for hot reload and runtime errors.

## Status: early preview

- You install it from a git checkout. It is not on npm or pub.dev yet.
- Tested on Android (emulator) and the iOS Simulator; real iPhones are untested. The install steps were run on macOS with zsh only. Windows and Linux are untested.
- The live view needs Drift. VS Code is untested.

## Start here

1. [[Try it without a device|Try-without-a-device]]: about 5 minutes, no Flutter, device or IDE needed.
2. [[Install guide|Install-guide]]: the full guide, from a git checkout to your own app.
3. [[Safety and privacy|Safety-and-privacy]]: what Claude can and can't do, and where your data goes.
4. [[FAQ]]: iOS, VS Code, release builds, Linear, and why FlutterDeck attaches instead of launching.
5. [[Feedback]]: tell us what is missing or wrong.

Repo: https://github.com/Thamzy265/project-deck
