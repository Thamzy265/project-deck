# Name shortlist

Checked on 2026-11-10 by the marketer. Draft for the PM, who chooses. Nothing is registered, reserved or published. This is research, not legal advice.

Open decision: `docs/PLAN.md`, "Risks, open decisions", "Project name". Work continues as FlutterDeck until the PM decides.

## How the checks were run

The marketer has no shell, so each check used the web fetch tool on a public URL. A 404 means the name is free at that moment. Free today is not reserved: someone can take it before we do.

- **npm:** `https://registry.npmjs.org/<name>`. A 404 means no package with that name. The CLI binary name is assumed to equal the package name; whether the binary name clashes with other tools on a user's PATH is not checked.
- **pub.dev:** `https://pub.dev/packages/<name>_drift`. A 404 means free. Other `<name>` and `<name>_*` package names are not checked.
- **GitHub:** `https://github.com/<name>`, the user or organisation name. Repo names under other owners are not checked.
- **Web search:** one query per name (queries listed under each name). Only the first page of results was read.
- **Not checked for any name:** domain names, social handles, Homebrew, Docker Hub, VS Code marketplace, and trademark registers (UK IPO, EUIPO, USPTO). Say "not checked" if asked. The PM should run the trademark register check on the final choice.

## Flutter's brand rules (applies to every name with "Flutter" in it)

"Flutter" is a Google trademark. The Flutter brand page (`https://flutter.dev/brand`, read 2026-11-10) says not to use the Flutter mark, or any variant of it, together with the overall name of your app, product, service or website. It also says Flutter branding must not suggest that Flutter endorses or built your product. The page I read did not mention package names or "for Flutter" phrasing, so I cannot say how Google treats those; that is not checked. A name that starts with "Flutter" is the highest-risk reading of the rule.

Descriptive use is safer: "a dashboard for Flutter developers" in a tagline, not "Flutter" inside the product name.

## Candidates

### 1. FlutterDeck (current working name)

- **Meaning and fit:** says what it is for at once. "Deck" suggests a control panel.
- **Trademark risk:** high. The name leads with Google's "Flutter" mark, which is what the brand page says not to do in a product name.
- **Clash risk:** high. A Flutter presentation framework already uses this name: pub.dev package `flutter_deck` (`https://pub.dev/packages/flutter_deck`) with docs at flutterdeck.dev, found by the web search `FlutterDeck Flutter developer tool` on 2026-11-10. It would appear in the same searches and the same community. I did not fetch flutterdeck.dev, so I do not know who owns the domain.
- **npm:** `https://registry.npmjs.org/flutterdeck` returned 404 (free), 2026-11-10.
- **pub.dev:** `https://pub.dev/packages/flutterdeck_drift` returned 404 (free), 2026-11-10.
- **GitHub:** `https://github.com/flutterdeck` returned 404 (free), 2026-11-10.
- **Other:** Flutter-only in the name, so Compose and web adapters (future, in the plan) would not fit.

### 2. Pitdeck

- **Meaning and fit:** a pit-stop deck, the place beside the track where you check the car while it keeps running. This matches "attaches to a running app, never launches it". Neutral about Flutter, Drift and Claude, so later adapters fit.
- **Trademark risk:** none found on Flutter, Dart or Google. Register check not done.
- **Clash risk:** low. The web search `"Pitdeck" software product developer tool` on 2026-11-10 found no product with this name. Results were about "pitch deck" presentation software, so people searching for it may be sent there. That is a discoverability cost.
- **npm:** `https://registry.npmjs.org/pitdeck` returned 404 (free), 2026-11-10.
- **pub.dev:** `https://pub.dev/packages/pitdeck_drift` returned 404 (free), 2026-11-10.
- **GitHub:** `https://github.com/pitdeck` returned 404 (free), 2026-11-10.

### 3. DriftDeck

- **Meaning and fit:** a deck for Drift. Says the headline feature, and is easy to remember.
- **Trademark risk:** "Drift" is the name of the Drift Dart library, which belongs to its maintainers; I did not check Drift's licence or naming policy, so that is not checked. A name that leads with Drift may read as an official Drift project. Drift is also the name of a separate chat product (drift.com); not checked further.
- **Clash risk:** low to medium. The web search `"DriftDeck" OR "Drift Deck" Flutter Drift database` on 2026-11-10 found no product with this name, only pages about the Drift library.
- **npm:** `https://registry.npmjs.org/driftdeck` returned 404 (free), 2026-11-10.
- **pub.dev:** `https://pub.dev/packages/driftdeck_drift` returned 404 (free), 2026-11-10. The suffix reads oddly (`driftdeck_drift`).
- **GitHub:** `https://github.com/driftdeck` is taken: an organisation with no public repositories and no description, 2026-11-10. Not known whether it is abandoned. We would need another owner name, for example a `driftdeck-dev` org (not checked).
- **Other:** narrows the product to Drift, which does not fit the live logs and reload buttons, or later Compose and web adapters.

### 4. Sidedeck

- **Meaning and fit:** the deck at Claude's side. Fits the "next to Claude" idea.
- **Trademark risk:** none found on Flutter, Dart or Google. Register check not done.
- **Clash risk:** medium. The web search `"Sidedeck" software product` on 2026-11-10 found a free Android DJ app called SideDeck on F-Droid (package `es.manifold.sidedeck`, GPL v3). Different field, but also an Android app.
- **npm:** `https://registry.npmjs.org/sidedeck` returned 404 (free), 2026-11-10.
- **pub.dev:** `https://pub.dev/packages/sidedeck_drift` returned 404 (free), 2026-11-10.
- **GitHub:** `https://github.com/sidedeck` is taken: a user account with 0 public repositories, 2026-11-10. We would need another owner name (not checked).

### Rejected during the check

- **Deckhand:** npm package `deckhand` exists (a task runner, last modified 2022-06-14), `https://registry.npmjs.org/deckhand`, 2026-11-10. pub.dev, GitHub and web search not checked.
- **Deckside:** npm package `deckside` exists (a connector CLI for web-controlled Codex agents, version 0.2.0), `https://registry.npmjs.org/deckside`, 2026-11-10. It is a close and AI-coding-related clash. Other checks not run.

## Summary

- **FlutterDeck:** npm free, pub.dev free, GitHub free. Clash: yes, `flutter_deck`. Flutter in the name: yes.
- **Pitdeck:** npm free, pub.dev free, GitHub free. Clash: none found ("pitch deck" noise). Flutter in the name: no.
- **DriftDeck:** npm free, pub.dev free, GitHub taken (empty org). Clash: none found. Flutter in the name: no (Drift is).
- **Sidedeck:** npm free, pub.dev free, GitHub taken (empty user). Clash: an Android DJ app. Flutter in the name: no.

## Recommendation

Move off FlutterDeck. It leads with Google's trademark, which Flutter's brand page tells projects not to do, and a Flutter presentation framework already uses the same name. Both problems get worse after a public release, and they are cheaper to fix now, while the packages are still unpublished and the name appears in few places.

My first choice is **Pitdeck**. It is the only candidate that is free on npm, pub.dev and GitHub, and the only one with no Flutter, Drift or other-product name in it. It matches the "attach, never launch" idea and leaves room for Compose and web adapters. The cost is that "pitdeck" may read as a typo of "pitch deck" in search, which a tagline ("for Flutter developers") can offset.

Second choice: **Sidedeck**, if the PM prefers the "next to Claude" meaning and can accept a different GitHub owner name. I would not choose DriftDeck: it narrows the product to one feature and borrows another project's name.

Before the PM commits, someone should check the candidate against the UK IPO and EUIPO registers, the domain, and the social handles. None of those was checked. A rename touches `@project-deck/*` scope decisions, the CLI binary, the `.flutterdeck/` folder and the `flutterdeck_drift` package. The lead should schedule that work. The choice is the PM's.

## Sources

- Flutter brand guidelines: https://flutter.dev/brand (read 2026-11-10)
- npm registry lookups, all 2026-11-10: https://registry.npmjs.org/flutterdeck, https://registry.npmjs.org/deckhand, https://registry.npmjs.org/driftdeck, https://registry.npmjs.org/sidedeck, https://registry.npmjs.org/deckside, https://registry.npmjs.org/pitdeck
- pub.dev lookups, all 2026-11-10: https://pub.dev/packages/flutterdeck_drift, https://pub.dev/packages/driftdeck_drift, https://pub.dev/packages/sidedeck_drift, https://pub.dev/packages/deckside_drift, https://pub.dev/packages/pitdeck_drift
- pub.dev `flutter_deck` (from web search): https://pub.dev/packages/flutter_deck
- GitHub lookups, all 2026-11-10: https://github.com/flutterdeck, https://github.com/driftdeck, https://github.com/sidedeck, https://github.com/pitdeck
- SideDeck on F-Droid (from web search): https://f-droid.org/ca/packages/es.manifold.sidedeck/
