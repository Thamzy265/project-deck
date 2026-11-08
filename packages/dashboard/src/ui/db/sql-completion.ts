/**
 * How long, in ms, a just-opened completion list ignores Enter and the arrow keys, so a
 * key meant as a new line doesn't pick an option that appeared under it. CodeMirror's
 * default, set explicitly so the e2e tests can wait it out.
 */
export const COMPLETION_INTERACTION_DELAY_MS = 75;
