/**
 * Test helper (not bundled: build.mjs bundles from the other packages' dist folders): the
 * paths the published pitdeck tarball may hold, shared by tarball.test.ts and
 * tarball-paths.test.ts.
 */

/** Every path the published tarball may hold. Anything else fails the test. */
export const ALLOWED: readonly RegExp[] = [
  /^package\.json$/,
  /^LICENSE$/,
  // Entry points: the CLI (bin), the daemon it starts, and the two worker threads.
  /^dist\/(cli|daemon|guard-worker|snapshot-worker)\.js$/,
  // Code shared between the entry points.
  /^dist\/chunk-[A-Z0-9]+\.js$/,
  /^dist\/sqlite3\.wasm$/,
  /^dist\/licenses\.md$/,
  // The daemon's fake mode reads these (`--fake`, used by the smoke test).
  /^dist\/fixtures\/(snap\.sqlite|snap\.sqlite-wal|plain\.sqlite)$/,
  /^dist\/dashboard\/(index\.html|licenses\.md)$/,
  /^dist\/dashboard\/assets\/[\w-]+\.(js|css)$/,
];

/**
 * Never published, even where a name fits ALLOWED (a dashboard asset may be named
 * anything): test and QA helpers, sources, maps, secrets and the project folder.
 */
export const DENIED: readonly RegExp[] = [
  /qa-client/,
  /fake-daemon/,
  /\.test\./,
  /\.map$/,
  /\.[cm]?tsx?$/,
  /(^|\/)\.env/,
  /(^|\/)\.pitdeck(\/|$)/,
];

/** The paths a tarball must not hold: not allowlisted, or denied. */
export const strayPaths = (paths: readonly string[]): string[] =>
  paths.filter((p) => !ALLOWED.some((re) => re.test(p)) || DENIED.some((re) => re.test(p)));
