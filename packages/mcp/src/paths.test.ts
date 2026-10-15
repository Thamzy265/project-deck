import { describe, expect, it } from 'vitest';
import { pathScrubber } from './paths.js';

describe('pathScrubber', () => {
  it('replaces the project folder first, then the home folder', () => {
    const scrub = pathScrubber('/home/jo/apps/shop', { home: '/home/jo', platform: 'linux' });
    expect(scrub('/home/jo/apps/shop/lib/main.dart and /home/jo/.flutterdeck/ports.json')).toBe(
      '<project>/lib/main.dart and ~/.flutterdeck/ports.json',
    );
  });

  it('on Windows ignores case and also finds the forward-slash form', () => {
    const scrub = pathScrubber('C:\\Users\\Jo\\shop', { home: 'C:\\Users\\Jo', platform: 'win32' });
    expect(
      scrub(
        'c:\\users\\jo\\shop\\a, C:/Users/Jo/shop/b, c:/USERS/jo/.flutterdeck and C:\\Users\\Jo',
      ),
    ).toBe('<project>\\a, <project>/b, ~/.flutterdeck and ~');
  });

  it('keeps case on other systems, where it matters', () => {
    const scrub = pathScrubber('/home/jo/shop', { home: '/home/jo', platform: 'linux' });
    expect(scrub('/HOME/JO/shop')).toBe('/HOME/JO/shop');
  });
});
