# docs/wiki

This folder is the source of the project's GitHub wiki. It is not a wiki page itself.

- The lead publishes the folder to the wiki repo `project-deck.wiki.git` (copy the `*.md` files except this README, then commit and push there). The file names are the wiki page names.
- `Install-guide.md` and `Try-without-a-device.md` are built from `docs/marketing/m3-install-guide.md`. Do not edit them by hand. Run `node scripts/wiki-install-guide.mjs` after a change to the guide. `node scripts/wiki-install-guide.mjs --check` fails when they are out of date.
- Links use the wiki syntax `[[Text|Page-name]]`. Prettier leaves it alone.
- The feedback thread is https://github.com/Thamzy265/project-deck/discussions/46 (posted 2026-10-26). `Feedback.md`, the root `README.md` and the posts link it.
- Pages must not hold tokens, VM service or DTD addresses, or personal data.
