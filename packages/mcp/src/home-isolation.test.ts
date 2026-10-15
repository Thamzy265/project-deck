import { homedir, tmpdir, userInfo } from 'node:os';
import { describe, expect, it } from 'vitest';

describe('test isolation', () => {
  it("points the home folder at a scratch folder, never the user's real one", () => {
    // userInfo() reads the account database, not HOME, so it still names the real home.
    expect(homedir()).not.toBe(userInfo().homedir);
    expect(homedir().startsWith(tmpdir())).toBe(true);
    expect(process.env.USERPROFILE).toBe(homedir());
  });
});
