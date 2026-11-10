/**
 * The `allowed-tools` and `disallowed-tools` of every skill name MCP tools as
 * `mcp__plugin_<plugin name>_<server key>__<tool>`. Claude Code ignores a pattern that matches
 * no tool without a message, so a rename of the plugin or of a server key would turn a deny rule
 * off silently. This test ties the patterns to the real `plugin.json` and `.mcp.json`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';
import { splitFrontmatter } from './frontmatter.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const JsonObject = z.record(z.string(), z.unknown());
const json = (path: string): Record<string, unknown> =>
  JsonObject.parse(JSON.parse(readFileSync(join(ROOT, path), 'utf8')));

const pluginName = String(json('.claude-plugin/plugin.json')['name']);
const servers = Object.keys(JsonObject.parse(json('.mcp.json')['mcpServers']));
const PREFIX = /^mcp__plugin_([^_]+(?:-[^_]+)*)_([^_]+(?:-[^_]+)*)__(.+)$/;

function toolsOf(skill: string): string[] {
  const text = readFileSync(join(ROOT, 'skills', skill, 'SKILL.md'), 'utf8');
  const front = JsonObject.parse(parse(splitFrontmatter(text)?.front ?? ''));
  return ['allowed-tools', 'disallowed-tools'].flatMap((key) => {
    const value = front[key];
    return Array.isArray(value) ? value.map(String) : [];
  });
}

describe('plugin-scoped tool patterns in skills', () => {
  const skills = readdirSync(join(ROOT, 'skills'));

  it('has a plugin named pitdeck with a pitdeck and a dart server', () => {
    expect(pluginName).toBe('pitdeck');
    expect([...servers].sort()).toEqual(['dart', 'pitdeck']);
  });

  it.each(skills)('/%s names only this plugin and a server that .mcp.json defines', (skill) => {
    const plugged = toolsOf(skill).filter((tool) => tool.startsWith('mcp__plugin_'));
    expect(plugged.length).toBeGreaterThan(0);
    for (const tool of plugged) {
      const match = PREFIX.exec(tool);
      expect(match, tool).not.toBeNull();
      const [, plugin, server] = match ?? [];
      // The Dart team's own plugin ships its server under another plugin name; that form stays.
      if (plugin === 'dart-flutter') continue;
      expect(plugin, tool).toBe(pluginName);
      expect(servers, tool).toContain(server);
    }
  });

  it('keeps the hot_restart deny rule on the server this plugin starts', () => {
    const denied = toolsOf('check');
    expect(denied).toContain(`mcp__plugin_${pluginName}_dart__hot_restart`);
  });
});
