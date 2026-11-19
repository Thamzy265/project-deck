/**
 * What the public marketplace installs (M5 batch 3, D2/D3): `git-subdir` copies every file
 * git tracks under plugin/ into users' caches, so that folder must hold nothing that is
 * dev-only, machine-specific or able to leave the plugin, and nothing the public
 * marketplace names may point at a checkout, a file URL or the dev marketplace.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLUGIN, REPO } from './paths.js';

/** Tracked files under plugin/ with their git modes, or undefined outside a git checkout. */
function tracked(): { mode: string; path: string }[] | undefined {
  // Without any GIT_* variable, which would point git somewhere else.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );
  try {
    const out = execFileSync('git', ['ls-files', '-s', '--', 'plugin'], {
      cwd: REPO,
      env,
      encoding: 'utf8',
      timeout: 20_000,
    });
    return out
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => ({ mode: l.slice(0, 6), path: l.split('\t')[1] ?? '' }));
  } catch {
    return undefined;
  }
}

const files = tracked();
const text = (path: string): string => readFileSync(join(REPO, path), 'utf8');

/** Machine-specific or non-portable text: a home path, a file URL, a Windows drive. */
const LOCAL = /\/Users\/|\/home\/[a-z]|file:\/\/|[A-Za-z]:\\\\|[A-Za-z]:\\[A-Za-z]/;

describe.skipIf(files === undefined)('files git-subdir ships from plugin/', () => {
  const list = files ?? [];

  it('lists the files the plugin needs and nothing else', () => {
    expect(list.map((f) => f.path).sort()).toEqual([
      'plugin/.claude-plugin/plugin.json',
      'plugin/.mcp.json',
      'plugin/README.md',
      'plugin/hooks/deck-hook.mjs',
      'plugin/hooks/hooks.json',
      'plugin/skills/check/SKILL.md',
      'plugin/skills/db/SKILL.md',
    ]);
  });

  it('holds no symlink (mode 120000) and no submodule (160000)', () => {
    expect(list.filter((f) => f.mode === '120000' || f.mode === '160000')).toEqual([]);
  });

  it('holds no hidden file except the two Claude Code reads, and no node_modules', () => {
    const allowed = new Set(['plugin/.claude-plugin/plugin.json', 'plugin/.mcp.json']);
    const hidden = list.filter(
      (f) => !allowed.has(f.path) && f.path.split('/').some((s) => s.startsWith('.')),
    );
    expect(hidden).toEqual([]);
    expect(list.filter((f) => /(^|\/)(node_modules|\.DS_Store)(\/|$)/.test(f.path))).toEqual([]);
  });

  it('holds no machine-specific path or file URL', () => {
    const bad = list.filter((f) => LOCAL.test(text(f.path))).map((f) => f.path);
    expect(bad).toEqual([]);
  });

  it('never reaches out of the plugin folder from its config, hook or skills', () => {
    // A cached copy has no packages/ folder beside it; `..` would also escape it.
    const bad = list
      .filter((f) => !f.path.endsWith('README.md'))
      .filter((f) => /\.\.[\\/]|CLAUDE_PLUGIN_ROOT\}?[\\/]\.\./.test(text(f.path)))
      .map((f) => f.path);
    expect(bad).toEqual([]);
  });

  it('keeps the hook free of imports from outside Node and the plugin', () => {
    // The hook runs from the cache with no node_modules: only built-ins may be imported.
    const source = text('plugin/hooks/deck-hook.mjs');
    const specs = [...source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.filter((s) => !(s ?? '').startsWith('node:'))).toEqual([]);
    expect(source).not.toMatch(/\brequire\(|import\(\s*['"][^n]/);
  });

  it('names no dev marketplace, checkout build or plugin-dev folder in files Claude loads', () => {
    const loaded = list.filter((f) => !f.path.endsWith('README.md')).map((f) => f.path);
    const bad = loaded.filter((p) =>
      /pitdeck-dev|plugin-dev|packages\/(pitdeck|cli)\/dist/.test(text(p)),
    );
    expect(bad).toEqual([]);
  });
});

describe('plugin/ on disk', () => {
  /** Everything below plugin/, links not followed, minus what git ignores at the top. */
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      out.push(path);
      if (lstatSync(path).isDirectory() && name !== 'node_modules') walk(path, out);
    }
    return out;
  }

  it('has no symlink and no stray .DS_Store below the top level', () => {
    const all = walk(PLUGIN).map((p) => relative(PLUGIN, p));
    const links = all.filter((p) => lstatSync(join(PLUGIN, p)).isSymbolicLink());
    expect(links).toEqual([]);
    expect(all.filter((p) => p.includes('/') && p.endsWith('.DS_Store'))).toEqual([]);
  });
});

describe('the public marketplace file and the plugin manifest', () => {
  it('sits alone in the repo-root .claude-plugin folder', () => {
    expect(readdirSync(join(REPO, '.claude-plugin'))).toEqual(['marketplace.json']);
  });

  it.each(['.claude-plugin/marketplace.json', 'plugin/.claude-plugin/plugin.json'])(
    '%s points at no checkout path, file URL, fork or the dev marketplace',
    (path) => {
      const body = text(path);
      expect(body).not.toMatch(LOCAL);
      expect(body).not.toMatch(/pitdeck-dev|plugin-dev|localhost|127\.0\.0\.1|\.\.\//);
      // Every URL it holds is https on github.com, under the owner's repo.
      const urls = [...body.matchAll(/https?:\/\/[^\s"]+/g)].map((m) => m[0]);
      expect(
        urls.filter((u) => !u.startsWith('https://github.com/Thamzy265/project-deck')),
      ).toEqual([]);
    },
  );

  it('installs from owner/repo shorthand: no scheme, credentials or extra path', () => {
    const market = JSON.parse(text('.claude-plugin/marketplace.json')) as {
      plugins: { source: { url: string; path: string } }[];
    };
    const [entry] = market.plugins;
    expect(entry?.source.url).toMatch(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/);
    expect(entry?.source.path).toBe('plugin');
  });
});

describe('install docs', () => {
  it.each(['README.md', 'plugin/README.md'])(
    '%s adds the public marketplace by repo, not by path',
    (path) => {
      const adds = [...text(path).matchAll(/marketplace add\s+(\S+)/g)].map((m) => m[1]);
      expect(adds.length).toBeGreaterThan(0);
      // The only path form is the contributors' dev marketplace, in plugin/README.md.
      const publicAdds = adds.filter((a) => !(a ?? '').includes('plugin-dev/marketplace'));
      expect(new Set(publicAdds)).toEqual(new Set(['Thamzy265/project-deck']));
    },
  );
});
