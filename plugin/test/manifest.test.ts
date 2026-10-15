/**
 * Shape of the plugin's JSON files, as the Claude Code plugin reference describes them
 * (code.claude.com/docs/en/plugins-reference and /hooks, read 15 Oct 2026). The
 * authoritative check is `claude plugin validate ./plugin`, which needs the Claude Code CLI.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DECK_VERSION } from '@project-deck/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PLUGIN_RELOAD_TOOL } from './fixtures.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));

const Manifest = z.object({
  name: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  displayName: z.string(),
  version: z.string(),
  description: z.string().min(1),
  author: z.object({ name: z.string().min(1) }),
  license: z.literal('MIT'),
  keywords: z.array(z.string()),
});

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
  it('is named flutterdeck and carries FlutterDeck’s version', () => {
    const manifest = Manifest.parse(read('.claude-plugin/plugin.json'));
    expect(manifest.name).toBe('flutterdeck');
    expect(manifest.version).toBe(DECK_VERSION);
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
    expect(market.name).toBe('flutterdeck-dev');
    expect(market.plugins[0]).toMatchObject({ name: 'flutterdeck', source: './plugin' });
  });
});

describe('.mcp.json', () => {
  const servers = z
    .strictObject({ mcpServers: z.strictObject({ dart: Stdio, flutterdeck: Stdio }) })
    .parse(read('.mcp.json')).mcpServers;

  it('runs the official Dart MCP server', () => {
    expect(servers.dart).toEqual({ type: 'stdio', command: 'dart', args: ['mcp-server'] });
  });

  it("runs this repo's CLI build next to the plugin folder (M2: local build, npx comes in M5)", () => {
    expect(servers.flutterdeck).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['${CLAUDE_PLUGIN_ROOT}/../packages/cli/dist/main.js', 'mcp'],
    });
    const cli = z
      .object({ bin: z.object({ flutterdeck: z.string() }) })
      .parse(read('../packages/cli/package.json'));
    const target = resolve(
      ROOT,
      (servers.flutterdeck.args[0] ?? '').replace('${CLAUDE_PLUGIN_ROOT}/', ''),
    );
    expect(target).toBe(resolve(ROOT, '..', 'packages', 'cli', cli.bin.flutterdeck));
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
        'mcp__plugin_flutterdeck_dart__hot_restart',
        'mcp__dart__hot_reload',
        'mcp__plugin_dart-flutter_dart-mcp-server__hot_restart',
      ]) {
        expect(matches(matcher(event), tool)).toBe(true);
      }
      for (const tool of [
        'mcp__plugin_flutterdeck_flutterdeck__deck_status',
        'mcp__plugin_flutterdeck_dart__get_runtime_errors',
        'mcp__vite__hot_reload',
        'Bash',
      ]) {
        expect(matches(matcher(event), tool)).toBe(false);
      }
    },
  );
});
