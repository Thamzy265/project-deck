/// <reference types="node" />
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The daemon keeps a per-user port registry in the home folder. Point HOME (and
 * USERPROFILE on Windows) at a scratch folder so no test, including the main.js child
 * processes, ever touches the real ~/.flutterdeck.
 */
export default function setup(): () => void {
  const home = mkdtempSync(join(tmpdir(), 'deck-test-home-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return () => rmSync(home, { recursive: true, force: true });
}
