/**
 * Tester probes of the plugin's slash commands (`skills/<name>/SKILL.md`), on top of
 * commands.test.ts. Claude Code reads the frontmatter without a message when a key is
 * wrong, so each probe here is about something that would fail silently.
 * Sources: code.claude.com/docs/en/skills (frontmatter keys, `allowed-tools` as a space- or
 * comma-separated string or a YAML list, `disallowed-tools`), read 4 Nov 2026.
 * Design abuse cases: docs/design/m4-plugin-commands.md "Trust boundaries and abuse cases".
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DbErrorCodeSchema } from '@project-deck/core';
import { describe, expect, it } from 'vitest';
import { parse, parseDocument } from 'yaml';
import { splitFrontmatter } from './frontmatter.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '..');

/** The 20 keys the skills page lists. Anything else is ignored by Claude Code without a message. */
const DOCUMENTED_KEYS = [
  'name',
  'description',
  'when_to_use',
  'argument-hint',
  'arguments',
  'disable-model-invocation',
  'user-invocable',
  'allowed-tools',
  'disallowed-tools',
  'model',
  'effort',
  'context',
  'agent',
  'background',
  'hooks',
  'paths',
  'shell',
  'metadata',
  'license',
  'compatibility',
];

const DART_PREFIXES = [
  'mcp__plugin_pitdeck_dart__',
  'mcp__plugin_dart-flutter_dart-mcp-server__',
  'mcp__dart__',
];
const NEGATION = /\b(never|no|not|don't|do not|without|nor|cannot|can't)\b/i;

function raw(name: string): string {
  return readFileSync(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');
}

function split(text: string): { front: string; body: string } {
  const parts = splitFrontmatter(text);
  if (parts === null) throw new Error('no frontmatter');
  return parts;
}

/** A tool list as Claude Code reads it: a YAML list, or a string split on spaces and commas outside brackets. */
function toolList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === ' ' || ch === ',' || ch === '\n' || ch === '\t')) {
      if (current !== '') out.push(current);
      current = '';
    } else current += ch;
  }
  if (current !== '') out.push(current);
  return out;
}

function frontmatter(name: string): Record<string, unknown> {
  const value: unknown = parse(split(raw(name)).front);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name}: frontmatter is not a map`);
  }
  return Object.fromEntries(Object.entries(value));
}

const body = (name: string) => split(raw(name)).body;

/** Lines of `text` that match `re` but have no negation word: an instruction to do it. */
const unnegated = (text: string, re: RegExp) =>
  text.split(/\r?\n/).filter((l) => re.test(l) && !NEGATION.test(l));

describe.each(['check', 'db'])('skills/%s frontmatter edge cases', (name) => {
  it('uses only keys the docs list, with exact spelling (a misspelt key is ignored silently)', () => {
    const keys = Object.keys(frontmatter(name));
    for (const key of keys) expect(DOCUMENTED_KEYS, `unknown key "${key}"`).toContain(key);
  });

  it('has no duplicate keys (the second one would silently win or lose)', () => {
    const doc = parseDocument(split(raw(name)).front, { uniqueKeys: true });
    expect(doc.errors.map((e) => e.message)).toEqual([]);
  });

  it('has no empty or null value', () => {
    for (const [key, value] of Object.entries(frontmatter(name))) {
      expect(value, key).not.toBeNull();
      if (typeof value === 'string') expect(value.trim(), key).not.toBe('');
      if (Array.isArray(value)) expect(value.length, key).toBeGreaterThan(0);
    }
  });

  it('writes each tool as one entry that reads the same as a list or as a joined string', () => {
    const front = frontmatter(name);
    for (const key of ['allowed-tools', 'disallowed-tools']) {
      const list = front[key];
      if (list === undefined) continue;
      expect(Array.isArray(list), `${key} is a YAML list`).toBe(true);
      const items = toolList(list);
      // A space or comma inside an entry would split it when someone rewrites the list as a string.
      // A whole MCP server may be denied as `mcp__<server>__*` (permissions docs, "Tool name wildcards").
      for (const item of items)
        expect(item, item).toMatch(/^(mcp__[A-Za-z0-9_-]+__\*|[A-Za-z][A-Za-z0-9_-]*)$/);
      expect(toolList(items.join(' '))).toEqual(items);
      expect(toolList(items.join(', '))).toEqual(items);
      expect(new Set(items).size, `${key} has a duplicate`).toBe(items.length);
    }
  });

  it('never allows and disallows the same tool', () => {
    const front = frontmatter(name);
    const allowed = toolList(front['allowed-tools']);
    const disallowed = toolList(front['disallowed-tools']);
    expect(allowed.filter((t) => disallowed.includes(t))).toEqual([]);
  });

  it('pre-approves no wildcard and no Bash pattern', () => {
    for (const tool of toolList(frontmatter(name)['allowed-tools'])) {
      expect(tool).not.toMatch(/\*|^Bash|^PowerShell|^Write|^Edit/);
    }
  });

  it('has a description that fits a listing line', () => {
    const description = frontmatter(name).description;
    expect(typeof description).toBe('string');
    expect(String(description).length).toBeLessThanOrEqual(1024);
    expect(String(description)).not.toMatch(/\r|\n/);
  });
});

describe.each(['check', 'db'])(
  'skills/%s body is data for Claude, never a way to run things',
  (name) => {
    it('has no dynamic shell injection (a bang before a backtick runs at load time)', () => {
      const text = body(name);
      expect(text).not.toMatch(/!`/);
      expect(text).not.toMatch(/```!/);
    });

    it('has no shell code fence and no link to follow', () => {
      const text = body(name);
      expect(text).not.toMatch(/```\s*(bash|sh|zsh|shell|powershell|ps1|cmd)\b/i);
      expect(text).not.toMatch(/https?:\/\//);
    });

    it('never tells Claude to use a shell, adb, sqlite3 or a file edit', () => {
      expect(unnegated(body(name), /\b(adb|sqlite3|rm -rf|curl|sudo)\b/)).toEqual([]);
    });

    it('says in its Rules that app data is untrusted, before the first step', () => {
      const text = body(name);
      const rule = text.search(/untrusted data/i);
      expect(rule).toBeGreaterThan(-1);
      expect(rule).toBeLessThan(text.search(/^## Steps/m));
    });

    it('names the error codes the daemon can really answer, and no other', () => {
      const codes = new Set(DbErrorCodeSchema.options);
      const named = [...body(name).matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)].map((m) => m[1] ?? '');
      const candidates = named.filter((n) => !n.includes('_') && !/^(read-only|self)|mcp/.test(n));
      for (const code of candidates) expect([...codes, 'choose-device'], code).toContain(code);
    });
  },
);

describe('/db stays read-only', () => {
  it('has no tool that can write in allowed-tools, and no non-Pitdeck tool at all', () => {
    for (const tool of toolList(frontmatter('db')['allowed-tools'])) {
      expect(tool).toMatch(
        /^mcp__plugin_pitdeck_pitdeck__(deck_status|db_list|db_schema|db_query)$/,
      );
    }
  });

  it('never gets db_snapshot or db_diff (no reason to read more than the question needs)', () => {
    const allowed = toolList(frontmatter('db')['allowed-tools']);
    expect(allowed.filter((t) => /db_snapshot|db_diff/.test(t))).toEqual([]);
  });

  it('removes PowerShell too: on Windows it is the shell Claude would use for adb or sqlite3', () => {
    // docs: "Bash or PowerShell" are the shell tools; Bash alone leaves a shell on Windows.
    expect(toolList(frontmatter('db')['disallowed-tools'])).toContain('PowerShell');
  });

  it('never mentions a write-capable Dart tool without a negation', () => {
    const writers = /\b(hot_reload|hot_restart|flutter_driver_command|pub)\b/;
    expect(unnegated(body('db'), writers)).toEqual([]);
  });

  it('shows no write statement in a code fence (the user types it in the dashboard)', () => {
    const fences = [...body('db').matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
    for (const fence of fences) {
      expect(fence).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|VACUUM)\b/i,
      );
    }
  });

  it('answers a change request by refusing, and says where the user can do it', () => {
    const text = body('db');
    const section = text.slice(text.indexOf('## When the user asks to change data'));
    expect(section).toMatch(/never writes/i);
    expect(section).toMatch(/dashboard/i);
    expect(section).toMatch(/Database/);
    expect(section).toMatch(/confirm/i);
  });

  it('caps the queries for one question', () => {
    expect(body('db')).toMatch(/Stop after 3 queries/);
  });

  it('has a path for no question and for no readable database', () => {
    const text = body('db');
    expect(text).toMatch(/\$ARGUMENTS` is empty/);
    expect(text).toMatch(/no database is readable/i);
  });
});

describe('/check never changes what it was not asked to change', () => {
  it('lists hot_restart in disallowed-tools for every Dart server name form (lead decision, 4 Nov 2026)', () => {
    const disallowed = toolList(frontmatter('check')['disallowed-tools']);
    for (const prefix of DART_PREFIXES) expect(disallowed).toContain(`${prefix}hot_restart`);
  });

  it('does not disallow a tool it needs', () => {
    const disallowed = toolList(frontmatter('check')['disallowed-tools']);
    for (const tool of toolList(frontmatter('check')['allowed-tools'])) {
      expect(disallowed).not.toContain(tool);
    }
  });

  it('pre-approves no launch, stop or restart tool, and the body names none as an action', () => {
    const allowed = toolList(frontmatter('check')['allowed-tools']);
    expect(allowed.filter((t) => /launch_app|stop_app|hot_restart|detach/.test(t))).toEqual([]);
    expect(unnegated(body('check'), /\b(launch_app|stop_app|hot_restart)\b/)).toEqual([]);
  });

  it('asks before editing, and never edits during the check', () => {
    const text = body('check');
    expect(text).toMatch(/Never edit code during \/check/);
    expect(text).toMatch(/Shall I make this change\?/);
  });

  it('keeps row values, URIs and tokens out of the report', () => {
    expect(body('check')).toMatch(/Never repeat row values, VM service or DTD URIs, or tokens/);
  });

  it('takes the log mark before the reload and reads logs after it', () => {
    const text = body('check');
    const at = (re: RegExp) => text.search(re);
    expect(at(/\*\*Log mark\.\*\*/)).toBeLessThan(at(/\*\*Reload\.\*\*/));
    expect(at(/\*\*Reload\.\*\*/)).toBeLessThan(at(/\*\*Logs\.\*\*/));
  });

  it('diffs against the latest snapshot: no db_diff call is given a snapshotId (D5)', () => {
    const lines = body('check')
      .split(/\r?\n/)
      .filter((l) => /`db_diff`/.test(l) && /snapshotId/.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/\b(only|without|no)\b/i);
  });

  it('handles a missing baseline: not-found takes a snapshot and says so', () => {
    const text = body('check');
    expect(text).toMatch(/`not-found`[\s\S]{0,200}`db_snapshot`/);
    expect(text).toMatch(/baseline taken now; the next \/check shows all changes/);
    expect(DbErrorCodeSchema.options).toContain('not-found');
  });

  it('ends with a new baseline for every database it read, labelled', () => {
    expect(body('check')).toMatch(/`db_snapshot` for each database from step 4, label `\/check`/);
  });

  it('stops, and says why, when there is no app, or no Dart connection', () => {
    const text = body('check');
    expect(text).toMatch(/`attached` is null[\s\S]{0,200}stop/);
    expect(text).toMatch(/If this fails, report the error's first line and stop/);
  });

  it('keeps the report short', () => {
    expect(body('check')).toMatch(/nothing longer than about 25 lines/);
  });
});

describe('Windows checkouts', () => {
  it('pins LF for text files, so a CRLF checkout cannot break the frontmatter fence', () => {
    const attributes = readFileSync(join(REPO, '.gitattributes'), 'utf8');
    expect(attributes).toMatch(/^\* text=auto eol=lf$/m);
  });

  it.each(['check', 'db'])('%s SKILL.md has no CR and no byte order mark', (name) => {
    const text = raw(name);
    expect(text).not.toContain('\r');
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    expect(text.startsWith('---\n')).toBe(true);
  });

  it.each(['check', 'db'])('%s frontmatter parses the same with CRLF line ends', (name) => {
    const crlf = raw(name).replace(/\n/g, '\r\n');
    const lf = split(raw(name));
    const win = split(crlf);
    expect(parse(win.front)).toEqual(parse(lf.front));
  });

  it('uses no Windows-hostile path or colon in the folder names', () => {
    for (const name of ['check', 'db']) expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
  });
});
