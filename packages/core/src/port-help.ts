import { DECK_VERSION } from './constants.js';

/**
 * A command line the user can paste: npx users have no `pitdeck` on their PATH, so
 * every command we print names the exact version this build belongs to.
 */
export function deckCommand(sub: string): string {
  return ['npx', ...deckNpxArgs(sub)].join(' ');
}

/** The arguments after `npx` that run one pinned release: the same spec `.mcp.json` uses. */
export function deckNpxArgs(sub: string, version: string = DECK_VERSION): string[] {
  return ['-y', `pitdeck@${version}`, sub];
}

/** How to pick another port. Shared so the daemon and the MCP server say the same words. */
export const HOW_TO_CHANGE_PORT = `run \`${deckCommand('init')}\`, or change "port" in .pitdeck/config.json and the url in .claude/launch.json.`;

/** Something that isn't this project's Pitdeck holds the configured port. */
export function portTakenText(port: number): string {
  return `Another program uses port ${port}. Stop it, or pick another port: ${HOW_TO_CHANGE_PORT}`;
}

/**
 * The program on the daemon's port didn't answer health in time. It may still be a Pitdeck
 * daemon, so nothing says "not running" and nothing starts a second one beside it. The
 * pid, when runtime.json gave one, is only a name for the user: Pitdeck never signals it.
 */
export function stalledText(port: number, pid?: number): string {
  const who = pid === undefined ? '' : ` (pid ${pid})`;
  return `Pitdeck daemon on port ${port}${who} didn't answer within the time limit. Quit ${pid === undefined ? 'it' : `process ${pid}`} by hand, then try again.`;
}
