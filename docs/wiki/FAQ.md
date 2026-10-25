# FAQ

## Does it work on iOS?

Checked on the iOS Simulator only; real iPhones are untested. We checked a read-only database copy (snapshot) on the simulator ourselves, and the maintainer checked the app on the simulator on 25 Oct 2026. We make no claim about iOS speed.

## Does it work with VS Code?

Untested with this release. We tested with Android Studio and `flutter run`. You can try VS Code: open your app's folder and choose **Run > Start Debugging**, then tell us how it went in [[Feedback]].

## Does it work in release or profile builds?

No. `flutterdeck_drift` works only in debug builds. We checked that a profile build does not include it. We have not built a release build.

## Does it support Linear or other task trackers?

Not in v1. Ask Claude to use your tracker's own MCP server. If you want tasks inside FlutterDeck, say so in [[Feedback]], question 12.

## Why does it attach instead of launching my app?

So your IDE keeps control. You start the app from your IDE or `flutter run`, as you do today. FlutterDeck finds the running app and connects to it. It never launches or stops the app, so your breakpoints still work.

## Where does my data go?

Nowhere outside your computer, except what Claude reads with FlutterDeck's tools: that goes into your Claude conversation like any other tool result. See [[Safety and privacy|Safety-and-privacy]].

## Can Claude change my database?

Not through FlutterDeck: its database tools refuse every query that writes. Claude Code's other tools (shell, file reads, the Browser pane) are not covered by this rule. See [[Safety and privacy|Safety-and-privacy]].

## Does it work on Windows or Linux?

Untested. CI runs the test suite there, but nobody ran the install steps there.

## Does it work without the Drift package?

The live view needs Drift. On Android, other SQLite databases can be read as a read-only snapshot copy; this was not tested in an app without the package. See the [[Install guide|Install-guide]].

## Is it on npm or pub.dev?

Not yet. You build it from a git checkout. Packages come with a later release.

## What licence is it?

Open source (MIT): https://github.com/Thamzy265/project-deck/blob/main/LICENSE

Back to [[Home]].
