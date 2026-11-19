import { describe, expect, it } from 'vitest';
import { DECK_VERSION } from './constants.js';
import { deckCommand, portTakenText } from './port-help.js';

describe('port help text', () => {
  it('names a command that works without pitdeck on the PATH', () => {
    expect(deckCommand('init')).toBe(`npx -y pitdeck@${DECK_VERSION} init`);
  });

  it('says how to change the port, with the pinned command', () => {
    const text = portTakenText(9147);
    expect(text).toContain('Another program uses port 9147.');
    expect(text).toContain(`\`${deckCommand('init')}\``);
    expect(text).toContain('.pitdeck/config.json');
    expect(text).not.toContain('`pitdeck init`');
  });
});
