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

  it('on Windows also hides the long form of a short (8.3) folder name', () => {
    // os.tmpdir() can give C:\Users\RUNNER~1\…, while the native realpath (and a
    // daemon resolving the folder) gives C:\Users\runneradmin\…: both are the same folder.
    const short = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\deck-x';
    const long = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\deck-x';
    const scrub = pathScrubber(short, {
      home: 'C:\\Users\\RUNNER~1',
      platform: 'win32',
      realPaths: (dir) => [dir.replace('RUNNER~1', 'runneradmin')],
    });
    expect(scrub(`${short}\\a, ${long}\\b and C:\\Users\\runneradmin\\c`)).toBe(
      '<project>\\a, <project>\\b and ~\\c',
    );
  });
});
