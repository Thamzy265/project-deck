// Tests for scripts/wiki-install-guide.mjs. The script has a fixed root (the folder above its own
// file), so each test copies it into a scratch tree with a copy of the real guide and mutates
// the copy. Fixture source: docs/marketing/m3-install-guide.md at test time.
// Note: vitest.config.ts has no project for scripts/, so `pnpm test` does not run this file yet.
// Run it with an empty vitest config: pnpm exec vitest run --config <file with "export default {};"> --root . scripts/wiki-install-guide.test.mjs
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '..');
const scriptSrc = join(repo, 'scripts', 'wiki-install-guide.mjs');
const guideSrc = join(repo, 'docs', 'marketing', 'm3-install-guide.md');
const PAGES = ['Install-guide.md', 'Try-without-a-device.md'];

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(mutate = (g) => g) {
  const dir = mkdtempSync(join(tmpdir(), 'wiki-guide-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'docs', 'marketing'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'wiki'), { recursive: true });
  copyFileSync(scriptSrc, join(dir, 'scripts', 'wiki-install-guide.mjs'));
  writeFileSync(
    join(dir, 'docs', 'marketing', 'm3-install-guide.md'),
    mutate(readFileSync(guideSrc, 'utf8')),
  );
  return dir;
}

function run(dir, ...args) {
  const r = spawnSync(process.execPath, [join(dir, 'scripts', 'wiki-install-guide.mjs'), ...args], {
    encoding: 'utf8',
  });
  return { status: r.status, stderr: r.stderr };
}

const page = (dir, name) => readFileSync(join(dir, 'docs', 'wiki', name), 'utf8');

// GitHub's heading anchor rule, close enough for these headings.
function slug(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-');
}

describe('wiki-install-guide: committed pages', () => {
  it('the committed wiki pages are up to date with the guide (regression lock)', () => {
    const r = run(repo, '--check');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('every in-page anchor resolves to a heading on the same page, and no link leaves the wiki', () => {
    for (const name of PAGES) {
      const text = readFileSync(join(repo, 'docs', 'wiki', name), 'utf8');
      const slugs = new Set([...text.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1])));
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1];
        if (target.startsWith('#'))
          expect(slugs.has(target.slice(1)), `${name}: ${target}`).toBe(true);
        else expect(target, `${name}: ${target}`).toMatch(/^https?:\/\//);
      }
    }
  });
});

describe('wiki-install-guide: generation', () => {
  it('writes both pages, is idempotent, and --check passes straight after', () => {
    const dir = scratch();
    expect(run(dir).status).toBe(0);
    const first = PAGES.map((n) => page(dir, n));
    expect(run(dir).status).toBe(0);
    expect(PAGES.map((n) => page(dir, n))).toEqual(first);
    expect(run(dir, '--check').status).toBe(0);
  });

  it('--check exits 1 and names the page when the source changed', () => {
    const dir = scratch();
    run(dir);
    writeFileSync(
      join(dir, 'docs', 'marketing', 'm3-install-guide.md'),
      readFileSync(guideSrc, 'utf8').replace('## What it is\n', '## What it is\n\nExtra line.\n'),
    );
    const r = run(dir, '--check');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Install-guide.md is out of date');
  });

  it('--check treats a missing wiki page as stale and writes nothing', () => {
    const dir = scratch();
    const r = run(dir, '--check');
    expect(r.status).toBe(1);
    expect(existsSync(join(dir, 'docs', 'wiki', 'Install-guide.md'))).toBe(false);
  });

  it('exits non-zero when the guide file is missing', () => {
    const dir = scratch();
    rmSync(join(dir, 'docs', 'marketing', 'm3-install-guide.md'));
    expect(run(dir).status).not.toBe(0);
    expect(run(dir, '--check').status).not.toBe(0);
  });

  it('keeps the repo-only parts out of both pages', () => {
    const dir = scratch();
    run(dir);
    const all = PAGES.map((n) => page(dir, n)).join('\n');
    expect(all).not.toContain('Open questions for the PM');
    expect(all).not.toContain('Claims in this draft');
    expect(all).not.toContain('PM decision');
  });
});

describe('wiki-install-guide: layout changes fail loudly and write nothing', () => {
  const renames = [
    ['## Open questions for the PM', '## Questions'],
    ['Draft for the M3 validation checkpoint', 'Draft for the validation checkpoint'],
    ['## 2. Try it without a device', '## 2. Try it in fake mode'],
    ['## 3. First run with the sample app', '## 3. First run'],
  ];
  for (const [from, to] of renames) {
    it(`renaming "${from}" exits non-zero and leaves the wiki folder empty`, () => {
      const dir = scratch((g) => g.replace(from, to));
      expect(run(dir).status).not.toBe(0);
      expect(existsSync(join(dir, 'docs', 'wiki', 'Install-guide.md'))).toBe(false);
      expect(existsSync(join(dir, 'docs', 'wiki', 'Try-without-a-device.md'))).toBe(false);
    });
  }

  // T2: the end marker moved before the start marker. slice() gives '' so a page with only
  // header and footer is written and the script exits 0.
  it('exits non-zero when the guide headings are out of order', () => {
    const dir = scratch((g) => {
      const open = g.indexOf('## Open questions for the PM');
      return `${g.slice(open)}\n${g.slice(0, open)}`;
    });
    expect(run(dir).status).not.toBe(0);
  });
});

describe('wiki-install-guide: Windows line endings', () => {
  const crlf = (g) => g.replace(/\r?\n/g, '\r\n');

  // T1: .gitattributes forces eol=lf, so this only happens when someone overrides it.
  it('--check does not call LF pages stale when the guide has CRLF line endings', () => {
    const lf = scratch();
    run(lf);
    const dir = scratch(crlf);
    for (const n of PAGES) writeFileSync(join(dir, 'docs', 'wiki', n), page(lf, n));
    const r = run(dir, '--check');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('the try-without-a-device page has one H1 and no leftover section 2 heading with CRLF input', () => {
    const dir = scratch(crlf);
    run(dir);
    expect(page(dir, 'Try-without-a-device.md')).not.toMatch(/^## 2\. /m);
  });
});
