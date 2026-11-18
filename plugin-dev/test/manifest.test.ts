/**
 * Shape of the plugin's JSON files, as the Claude Code plugin reference describes them
 * (code.claude.com/docs/en/plugins-reference and /hooks, read 15 Oct 2026). The
 * authoritative check is `claude plugin validate ./plugin`, which needs the Claude Code CLI.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DECK_VERSION } from '@project-deck/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PLUGIN_RELOAD_TOOL } from './fixtures.js';
import { PLUGIN } from './paths.js';

const ROOT = PLUGIN;
const read = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));

const REPO_URL = 'https://github.com/Thamzy265/project-deck';

const Manifest = z.strictObject({
  name: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  displayName: z.string(),
  version: z.string(),
  description: z.string().min(1).max(300),
  author: z.strictObject({ name: z.string().min(1), url: z.url() }),
  // Claude Code refuses to load a plugin whose homepage is not a URL.
  homepage: z.url(),
  repository: z.url(),
  license: z.literal('MIT'),
  keywords: z.array(z.string()).min(1),
});

/**
 * An exact npm version: x.y.z with an optional prerelease (0.1.0-preview.0), no build
 * metadata, no range, no tag. semver.org's grammar for the core and prerelease parts.
 */
const NUMBER = '(?:0|[1-9]\\d*)';
const PRE_ID = '(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)';
const EXACT_VERSION = new RegExp(
  `^${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-${PRE_ID}(?:\\.${PRE_ID})*)?$`,
);

/** The CLI version the pitdeck server's npx args pin, or undefined if they pin none. */
function pinnedVersion(args: readonly string[]): string | undefined {
  if (args.length !== 3 || args[0] !== '-y' || args[2] !== 'mcp') return undefined;
  const spec = args[1] ?? '';
  if (!spec.startsWith('pitdeck@')) return undefined;
  const version = spec.slice('pitdeck@'.length);
  return EXACT_VERSION.test(version) ? version : undefined;
}

const Stdio = z.strictObject({
  type: z.literal('stdio'),
  command: z.string(),
  args: z.array(z.string()),
});

const Handler = z.strictObject({
  type: z.literal('command'),
  command: z.literal('node'),
  args: z.tuple([z.literal('${CLAUDE_PLUGIN_ROOT}/hooks/deck-hook.mjs')]),
  async: z.literal(true),
  timeout: z.number().int().positive(),
});
const Group = z.strictObject({ matcher: z.string().optional(), hooks: z.tuple([Handler]) });
const HooksFile = z.strictObject({
  description: z.string(),
  hooks: z.strictObject({
    Stop: z.tuple([Group]),
    SubagentStop: z.tuple([Group]),
    Notification: z.tuple([Group]),
    PostToolUse: z.tuple([Group]),
    PostToolUseFailure: z.tuple([Group]),
  }),
});

/** Claude Code's rule: only letters, digits, _, -, spaces, `,` and `|` is a list of exact names. */
function matches(matcher: string | undefined, value: string): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  if (/^[\w\s,|-]+$/.test(matcher))
    return matcher
      .split(/[|,]/)
      .map((s) => s.trim())
      .includes(value);
  return new RegExp(matcher).test(value);
}

describe('plugin manifest', () => {
  it('is named pitdeck and carries Pitdeck’s version', () => {
    const manifest = Manifest.parse(read('.claude-plugin/plugin.json'));
    expect(manifest.name).toBe('pitdeck');
    expect(manifest.version).toBe(DECK_VERSION);
  });

  it('carries release metadata that points at this repo', () => {
    const manifest = Manifest.parse(read('.claude-plugin/plugin.json'));
    expect(manifest.repository).toBe(REPO_URL);
    expect(manifest.homepage.startsWith(REPO_URL)).toBe(true);
    expect(manifest.author.url).toBe(REPO_URL);
  });

  it('carries the same version as the published pitdeck package and the daemon (F6)', () => {
    const pkg = z
      .object({ name: z.literal('pitdeck'), version: z.string() })
      .parse(read('../packages/pitdeck/package.json'));
    const manifest = Manifest.parse(read('.claude-plugin/plugin.json'));
    // One release: `pitdeck --version`, /api/health and the plugin all report one number.
    expect({ pkg: pkg.version, plugin: manifest.version }).toEqual({
      pkg: DECK_VERSION,
      plugin: DECK_VERSION,
    });
  });
});

describe('the shipped plugin folder', () => {
  // A git-subdir install copies this whole folder into users' plugin caches; the format
  // has no way to leave files out, so tests, evals and dev config live in plugin-dev/.
  it('holds only the files Claude Code loads, and the README', () => {
    // Git-ignored, so never in a git-subdir checkout: Finder's file and the node_modules
    // that an older checkout's `pnpm install` left in plugin/.
    const ignored = new Set(['.DS_Store', 'node_modules']);
    const entries = readdirSync(ROOT).filter((name) => !ignored.has(name));
    expect(entries.sort()).toEqual(['.claude-plugin', '.mcp.json', 'README.md', 'hooks', 'skills']);
    expect(readdirSync(join(ROOT, '.claude-plugin'))).toEqual(['plugin.json']);
  });
});

describe('development marketplace', () => {
  it('lists this folder as a relative path, so Claude Code loads it in place', () => {
    const market = z
      .object({
        name: z.string(),
        owner: z.object({ name: z.string().min(1) }),
        plugins: z.tuple([z.object({ name: z.string(), source: z.string() })]),
      })
      .parse(read('../.claude-plugin/marketplace.json'));
    expect(market.name).toBe('pitdeck-dev');
    expect(market.plugins[0]).toMatchObject({ name: 'pitdeck', source: './plugin' });
  });
});

describe('.mcp.json', () => {
  const servers = z
    .strictObject({ mcpServers: z.strictObject({ dart: Stdio, pitdeck: Stdio }) })
    .parse(read('.mcp.json')).mcpServers;

  it('runs the official Dart MCP server', () => {
    expect(servers.dart).toEqual({ type: 'stdio', command: 'dart', args: ['mcp-server'] });
  });

  it('runs the released CLI through npx, pinned to this release (ADR 0007)', () => {
    expect(servers.pitdeck).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', `pitdeck@${DECK_VERSION}`, 'mcp'],
    });
  });

  it('pins the same exact version as plugin.json, the pitdeck package and DECK_VERSION', () => {
    const pkg = z
      .object({ name: z.literal('pitdeck'), version: z.string() })
      .parse(read('../packages/pitdeck/package.json'));
    const manifest = Manifest.parse(read('.claude-plugin/plugin.json'));
    const pin = pinnedVersion(servers.pitdeck.args);
    expect(pin).toBeDefined();
    expect({ plugin: manifest.version, pkg: pkg.version, core: DECK_VERSION }).toEqual({
      plugin: pin,
      pkg: pin,
      core: pin,
    });
  });

  it('starts nothing from the checkout: no path, no local build', () => {
    const text = JSON.stringify(servers.pitdeck);
    expect(text).not.toMatch(/CLAUDE_PLUGIN_ROOT|\.\.|packages|dist|\.js/);
  });
});

describe('the npx pin check', () => {
  it.each(['0.1.0', '0.1.0-preview.0', '1.2.3-rc.1', '10.20.30-alpha-1.beta'])(
    'accepts the exact version %s',
    (version) => {
      expect(pinnedVersion(['-y', `pitdeck@${version}`, 'mcp'])).toBe(version);
    },
  );

  it.each([
    'latest',
    'next',
    '^0.1.0',
    '~0.1.0',
    '>=0.1.0',
    '0.1',
    '0.1.x',
    '*',
    '0.1.0 || 0.2.0',
    '0.1.0+build.1',
    '01.1.0',
    '0.1.0-',
    '0.1.0-01',
    '',
  ])('refuses the range or tag %j', (version) => {
    expect(pinnedVersion(['-y', `pitdeck@${version}`, 'mcp'])).toBeUndefined();
  });

  it('refuses another package, a missing -y and extra arguments', () => {
    expect(pinnedVersion(['-y', 'pitdek@0.1.0', 'mcp'])).toBeUndefined();
    expect(pinnedVersion(['pitdeck@0.1.0', 'mcp'])).toBeUndefined();
    expect(pinnedVersion(['-y', 'pitdeck@0.1.0', 'mcp', '--project', '/x'])).toBeUndefined();
  });
});

describe('hooks/hooks.json', () => {
  const { hooks } = HooksFile.parse(read('hooks/hooks.json'));
  const matcher = (event: keyof typeof hooks) => hooks[event][0].matcher;

  it('runs the hook script on every event, for Stop and SubagentStop without a matcher', () => {
    expect(matcher('Stop')).toBeUndefined();
    expect(matcher('SubagentStop')).toBeUndefined();
  });

  it('runs on the waiting notifications only', () => {
    for (const type of [
      'permission_prompt',
      'idle_prompt',
      'elicitation_dialog',
      'agent_needs_input',
    ]) {
      expect(matches(matcher('Notification'), type)).toBe(true);
    }
    for (const type of [
      'auth_success',
      'elicitation_complete',
      'elicitation_response',
      'agent_completed',
    ]) {
      expect(matches(matcher('Notification'), type)).toBe(false);
    }
  });

  it.each(['PostToolUse', 'PostToolUseFailure'] as const)(
    "runs on the Dart MCP server's reload tools only (%s)",
    (event) => {
      for (const tool of [
        PLUGIN_RELOAD_TOOL,
        'mcp__plugin_pitdeck_dart__hot_restart',
        'mcp__dart__hot_reload',
        'mcp__plugin_dart-flutter_dart-mcp-server__hot_restart',
      ]) {
        expect(matches(matcher(event), tool)).toBe(true);
      }
      for (const tool of [
        'mcp__plugin_pitdeck_pitdeck__deck_status',
        'mcp__plugin_pitdeck_dart__get_runtime_errors',
        'mcp__vite__hot_reload',
        'Bash',
      ]) {
        expect(matches(matcher(event), tool)).toBe(false);
      }
    },
  );
});
