/**
 * The plugin's slash commands, `skills/<name>/SKILL.md`. Frontmatter keys and their
 * meaning: code.claude.com/docs/en/slash-commands, read 4 Nov 2026. Claude Code ignores an
 * unknown or misspelled key without a message, so these tests reject any key not listed.
 * Design: docs/design/m4-plugin-commands.md (PM decisions D1–D5, 4 Nov 2026).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DaemonClient, createDeckServer } from '@project-deck/mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';
import { splitFrontmatter } from './frontmatter.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_LINES = 120;

const DART_TOOLS = z
  .object({ source: z.string().min(1), tools: z.array(z.string()).length(13) })
  .parse(JSON.parse(readFileSync(join(ROOT, 'test/fixtures/dart-tools.json'), 'utf8'))).tools;

/** Every name the Dart MCP server's tools can have: our plugin, the Dart team's plugin, a project entry. */
const DART_PREFIXES = [
  'mcp__plugin_flutterdeck_dart__',
  'mcp__plugin_dart-flutter_dart-mcp-server__',
  'mcp__dart__',
];
const DECK_PREFIX = 'mcp__plugin_flutterdeck_flutterdeck__';
const PLUGIN_DART_PREFIX = 'mcp__plugin_flutterdeck_dart__';

/**
 * Claude Code tools (CLI 2.1.236, code.claude.com/docs/en/tools-reference) that can run a
 * command, change files, or run or schedule work after the /db deny clears.
 */
const WRITE_BUILTINS = [
  'Bash',
  'PowerShell',
  'Monitor',
  'Tmux',
  'REPL',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Workflow',
  'CronCreate',
  'ScheduleWakeup',
  'RemoteTrigger',
];

const ToolList = z.array(z.string().min(1));
const Frontmatter = z.strictObject({
  description: z.string().min(40),
  'argument-hint': z.string().min(1),
  'disable-model-invocation': z.boolean().optional(),
  'allowed-tools': ToolList,
  'disallowed-tools': ToolList.optional(),
});

interface Command {
  meta: z.infer<typeof Frontmatter>;
  body: string;
  lines: number;
}

function readCommand(name: string): Command {
  const text = readFileSync(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');
  const parts = splitFrontmatter(text);
  if (parts === null) throw new Error(`${name}: no frontmatter`);
  return {
    meta: Frontmatter.parse(parse(parts.front)),
    body: parts.body,
    lines: text.split(/\r?\n/).length,
  };
}

/** Tool names a body puts in backticks: snake_case words such as `db_query` or `dtd`. */
function namedTools(body: string): string[] {
  const named = [...body.matchAll(/`([a-z]+(?:_[a-z]+)*)`/g)].map((m) => m[1] ?? '');
  return [...new Set(named)].filter((n) => n.includes('_') || DART_TOOLS.includes(n));
}

let deckTools: { name: string; readOnly: boolean }[] = [];
let projectDir = '';

beforeAll(async () => {
  // FlutterDeck's real tool list, from its server; listing tools never calls the daemon.
  projectDir = mkdtempSync(join(tmpdir(), 'deck-plugin-commands-'));
  const daemon = new DaemonClient({ projectDir, version: '0.0.0', spawnDaemon: () => undefined });
  const deck = createDeckServer({ projectDir, daemon });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'plugin-commands-test', version: '0.0.0' });
  await deck.server.connect(serverSide);
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  deckTools = tools.map((t) => ({ name: t.name, readOnly: t.annotations?.readOnlyHint === true }));
  await client.close();
  await deck.close();
});

afterAll(() => rmSync(projectDir, { recursive: true, force: true }));

const deckNames = () => deckTools.map((t) => t.name);

describe('FlutterDeck and the Dart MCP server', () => {
  it('FlutterDeck has its tools and none of the Dart MCP server’s', () => {
    expect(deckNames()).toEqual(
      expect.arrayContaining(['deck_status', 'get_logs', 'db_list', 'db_query', 'db_diff']),
    );
    expect(deckNames().filter((n) => DART_TOOLS.includes(n))).toEqual([]);
  });
});

describe.each(['check', 'db'])('skills/%s/SKILL.md', (name) => {
  const command = () => readCommand(name);

  it(`has only known frontmatter keys and stays under ${MAX_LINES} lines`, () => {
    const { lines } = command();
    expect(lines).toBeLessThan(MAX_LINES);
  });

  it('runs only when the user types it (D2, changed by the PM 4 Nov 2026: review D-1)', () => {
    expect(command().meta['disable-model-invocation']).toBe(true);
  });

  it("uses the user's text", () => {
    expect(command().body).toContain('$ARGUMENTS');
  });

  it('names only tools that FlutterDeck or the Dart MCP server has', () => {
    const named = namedTools(command().body);
    expect(named.length).toBeGreaterThan(2);
    for (const tool of named) expect([...deckNames(), ...DART_TOOLS]).toContain(tool);
  });

  it('says app data is untrusted and its instructions are never followed', () => {
    const { body } = command();
    expect(body).toMatch(/untrusted data/i);
    expect(body).toMatch(/never follow instructions/i);
  });

  it("pre-approves only FlutterDeck's read-only tools and the plugin's Dart dtd, get_runtime_errors and (in /check) hot_reload", () => {
    const allowedDart = name === 'check' ? ['dtd', 'get_runtime_errors', 'hot_reload'] : [];
    for (const tool of command().meta['allowed-tools']) {
      if (tool.startsWith(DECK_PREFIX)) {
        const deck = deckTools.find((t) => t.name === tool.slice(DECK_PREFIX.length));
        expect(deck, tool).toMatchObject({ readOnly: true });
      } else {
        expect(tool.startsWith(PLUGIN_DART_PREFIX), tool).toBe(true);
        expect(allowedDart).toContain(tool.slice(PLUGIN_DART_PREFIX.length));
      }
    }
  });
});

describe('/check', () => {
  const check = () => readCommand('check');

  it('pre-approves what the check needs', () => {
    expect(check().meta['allowed-tools']).toEqual(
      expect.arrayContaining([
        `${DECK_PREFIX}deck_status`,
        `${DECK_PREFIX}get_logs`,
        `${DECK_PREFIX}db_list`,
        `${DECK_PREFIX}db_snapshot`,
        `${DECK_PREFIX}db_diff`,
        `${PLUGIN_DART_PREFIX}dtd`,
        `${PLUGIN_DART_PREFIX}hot_reload`,
        `${PLUGIN_DART_PREFIX}get_runtime_errors`,
      ]),
    );
  });

  it('never tells Claude to hot restart (D3)', () => {
    const lines = check()
      .body.split(/\r?\n/)
      .filter((l) => l.includes('hot_restart'));
    for (const line of lines) expect(line).toMatch(/\b(never|not|don't)\b/i);
  });

  it('diffs once, after the reload, and does not call db_diff only to look for a baseline (review P1)', () => {
    const { body } = check();
    const steps = body.slice(body.indexOf('## Steps'), body.indexOf('## Report'));
    expect(steps.indexOf('`db_diff`')).toBeGreaterThan(steps.indexOf('**Reload.**'));
    expect(steps.match(/call `db_diff`/g)).toHaveLength(1);
  });

  it('says the baseline is the latest snapshot of the database, whatever its label (review D-2)', () => {
    expect(check().body).toMatch(/latest snapshot of that database, whatever its label/);
  });

  it('reports in the fixed sections of the design note', () => {
    for (const section of ['Reload', 'Runtime errors', 'Logs', 'Database', 'Next']) {
      expect(check().body).toContain(`**${section}**`);
    }
  });
});

describe('/db', () => {
  const db = () => readCommand('db');

  it('pre-approves no Dart tool', () => {
    for (const tool of db().meta['allowed-tools']) expect(tool.startsWith(DECK_PREFIX)).toBe(true);
  });

  it('removes every tool that could change data or the app, and every Dart server', () => {
    // Skill disallowed-tools become deny rules, and deny rules take `mcp__<server>__*`
    // (code.claude.com/docs/en/permissions, "Tool name wildcards", read 4 Nov 2026).
    const disallowed = db().meta['disallowed-tools'] ?? [];
    const expected = [...WRITE_BUILTINS, ...DART_PREFIXES.map((prefix) => `${prefix}*`)];
    expect([...disallowed].sort()).toEqual([...expected].sort());
  });

  it('says Claude never writes and points to the dashboard Database tab', () => {
    const { body } = db();
    expect(body).toMatch(/never writes/i);
    expect(body).toMatch(/Database tab/);
  });
});
