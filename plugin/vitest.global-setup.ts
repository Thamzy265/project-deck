/// <reference types="node" />
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The hook never reads the home folder; a scratch one makes sure no test can touch it. */
export default function setup(): () => void {
  const home = mkdtempSync(join(tmpdir(), 'deck-plugin-home-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return () => rmSync(home, { recursive: true, force: true });
}
