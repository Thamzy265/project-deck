import { describe, expect, it } from 'vitest';
import { DECK_VERSION } from './constants.js';
import { deckCommand, deckNpxArgs, portTakenText, stalledText } from './port-help.js';

describe('port help text', () => {
  it('names a command that works without pitdeck on the PATH', () => {
    expect(deckCommand('init')).toBe(`npx -y pitdeck@${DECK_VERSION} init`);
  });

  it('builds the printed command and the .mcp.json args from one spec', () => {
    expect(deckNpxArgs('mcp', '1.2.3')).toEqual(['-y', 'pitdeck@1.2.3', 'mcp']);
    expect(deckCommand('stop').split(' ')).toEqual(['npx', ...deckNpxArgs('stop')]);
  });

  it('says how to change the port, with the pinned command', () => {
    const text = portTakenText(9147);
    expect(text).toContain('Another program uses port 9147.');
    expect(text).toContain(`\`${deckCommand('init')}\``);
    expect(text).toContain('.pitdeck/config.json');
    expect(text).not.toContain('`pitdeck init`');
  });

  it('says the same words for a stalled daemon, with or without its pid', () => {
    expect(stalledText(9147, 42)).toBe(
      "Pitdeck daemon on port 9147 (pid 42) didn't answer within the time limit. Quit process 42 by hand, or delete .pitdeck/runtime.json if no Pitdeck runs, then try again.",
    );
    expect(stalledText(9147)).toBe(
      "Pitdeck daemon on port 9147 didn't answer within the time limit. Quit it by hand, or delete .pitdeck/runtime.json if no Pitdeck runs, then try again.",
    );
  });
});
