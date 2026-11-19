import { DECK_VERSION } from './constants.js';

/**
 * A command line the user can paste: npx users have no `pitdeck` on their PATH, so
 * every command we print names the exact version this build belongs to.
 */
export function deckCommand(sub: string): string {
  return `npx -y pitdeck@${DECK_VERSION} ${sub}`;
}

/** How to pick another port. Shared so the daemon and the MCP server say the same words. */
export const HOW_TO_CHANGE_PORT = `run \`${deckCommand('init')}\`, or change "port" in .pitdeck/config.json and the url in .claude/launch.json.`;

/** Something that isn't this project's Pitdeck holds the configured port. */
export function portTakenText(port: number): string {
  return `Another program uses port ${port}. Stop it, or pick another port: ${HOW_TO_CHANGE_PORT}`;
}
