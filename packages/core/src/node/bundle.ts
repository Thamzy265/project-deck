/**
 * Set to `true` at build time by packages/pitdeck/build.mjs (an esbuild `define`), and
 * nowhere else: tsc output and tests leave it undeclared. A build-time flag rather than a
 * look at the file system, so no file a user or a planted package can create changes it.
 */
declare const __PITDECK_BUNDLE__: boolean | undefined;

/**
 * True when this code runs from the published `pitdeck` npm bundle. Then its files
 * (daemon.js, dashboard/, fixtures/) must be next to the code, and nothing is looked up
 * through node_modules or NODE_PATH: users don't own the `@project-deck` npm scope, so a
 * look-alike package up the folder tree must never be loaded.
 */
export const IN_PITDECK_BUNDLE: boolean =
  typeof __PITDECK_BUNDLE__ !== 'undefined' && __PITDECK_BUNDLE__;

/** A file the bundle ships next to its code is missing: the install is incomplete. */
export class IncompleteBundleError extends Error {
  constructor(path: string) {
    super(`The pitdeck package is incomplete: ${path} is missing. Reinstall pitdeck.`);
    this.name = 'IncompleteBundleError';
  }
}
