/// <reference types="node" />
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { changedEntries, snapshotDir } from './src/testing/home-guard.js';

/**
 * The daemon keeps a per-user port registry in the home folder. Point HOME (and
 * USERPROFILE on Windows) at a scratch folder so no test, including the main.js child
 * processes, ever touches the real ~/.flutterdeck; the run fails if one did.
 */
export default function setup(): () => void {
  // userInfo() reads the account database, not HOME, so it names the real home.
  const real = join(userInfo().homedir, '.flutterdeck');
  const before = snapshotDir(real);
  const home = mkdtempSync(join(tmpdir(), 'deck-test-home-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return () => {
    rmSync(home, { recursive: true, force: true });
    const changed = changedEntries(before, snapshotDir(real));
    if (changed.length > 0) {
      throw new Error(`A test wrote to the real ${real}: ${changed.join(', ')}`);
    }
  };
}
