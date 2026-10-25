// Builds docs/wiki/Install-guide.md and docs/wiki/Try-without-a-device.md from docs/marketing/m3-install-guide.md so the wiki page
// never becomes a hand-edited copy. Usage: node scripts/wiki-install-guide.mjs [--check]
// --check exits 1 when a committed wiki page differs from what the guide would give.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const guide = readFileSync(`${root}docs/marketing/m3-install-guide.md`, 'utf8');

// Drop the repo-only parts: the source and name notes at the top, and everything from the
// PM's open questions on (open questions and the claims table).
const start = guide.indexOf('# ');
const title = guide.slice(start, guide.indexOf('\n', start) + 1);
const afterNotes = guide.indexOf('Draft for the M3 validation checkpoint');
const end = guide.indexOf('## Open questions for the PM');
if (afterNotes < 0 || end < 0) throw new Error('The guide layout changed: update this script.');

const header =
  `${title}\n` +
  '> This page is built from `docs/marketing/m3-install-guide.md` in the repo, which is the source. ' +
  'Do not edit it here. See also [[Safety and privacy|Safety-and-privacy]], [[FAQ]] and [[Feedback]].\n\n';
const footer =
  '\n## More\n\n- [[Try it without a device|Try-without-a-device]]\n- [[Safety and privacy|Safety-and-privacy]]\n- [[FAQ]]\n- [[Feedback]]\n';
const out = header + guide.slice(afterNotes, end).trimEnd() + '\n' + footer;

// Section 2 of the guide is also a page of its own, for people who only want to look.
const fakeStart = guide.indexOf('## 2. Try it without a device');
const fakeEnd = guide.indexOf('## 3. First run with the sample app');
if (fakeStart < 0 || fakeEnd < 0) throw new Error('The guide layout changed: update this script.');
const fake =
  '# Try FlutterDeck without a device\n\n' +
  '> This page is built from `docs/marketing/m3-install-guide.md` in the repo, which is the source. ' +
  'Do not edit it here. You first need step 1 of the [[Install guide|Install-guide]]: clone and build into `$HOME/project-deck`.\n\n' +
  guide
    .slice(fakeStart, fakeEnd)
    .replace(/^## 2\. .*\n\n/, '')
    .trimEnd() +
  '\n\n## More\n\n- [[Install guide|Install-guide]]\n- [[Safety and privacy|Safety-and-privacy]]\n- [[Feedback]]\n';

const pages = { 'Install-guide.md': out, 'Try-without-a-device.md': fake };
let stale = false;
for (const [name, text] of Object.entries(pages)) {
  const target = `${root}docs/wiki/${name}`;
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(target, 'utf8');
    } catch {
      // A missing file counts as a difference.
    }
    if (current !== text) {
      console.error(`docs/wiki/${name} is out of date: run node scripts/wiki-install-guide.mjs`);
      stale = true;
    }
  } else {
    writeFileSync(target, text);
  }
}
if (stale) process.exit(1);
