/**
 * `.claude/launch.json`, which Claude Desktop's Browser pane reads. The file allows
 * comments (JSONC), so it is edited in place with jsonc-parser: other configurations,
 * comments and layout stay as they are. Checked against code.claude.com/docs/en/desktop
 * ("Configure preview servers") on 15 Oct 2026: an entry with a `url` and no command
 * attaches to a running server; a localhost `url` must be the origin alone and match the
 * entry's `port`, so the entry carries both.
 */
import type { Node, ParseError } from 'jsonc-parser';
import { getNodeValue, parseTree } from 'jsonc-parser';
import { setJsonValue } from './text-format.js';

export const LAUNCH_ENTRY_NAME = 'FlutterDeck';
const LAUNCH_VERSION = '0.0.1';

export interface LaunchEntry {
  name: string;
  url: string;
  port: number;
}

export function launchEntry(port: number): LaunchEntry {
  return { name: LAUNCH_ENTRY_NAME, url: `http://127.0.0.1:${port}`, port };
}

export type LaunchMerge =
  { kind: 'unchanged' } | { kind: 'changed'; text: string } | { kind: 'refused'; reason: string };

interface Parsed {
  root: Node;
  /** Every configuration's value, in order. */
  configurations: unknown[];
  /** Where ours is, or -1. */
  ours: number;
}

/** Messages name the problem, never the file's text: it is the user's (or a repo's). */
function parse(text: string): Parsed | string {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || root === undefined) {
    return 'is not valid JSON (comments are allowed)';
  }
  if (root.type !== 'object') return 'is not a JSON object';
  const list = root.children?.find((prop) => prop.children?.[0]?.value === 'configurations')
    ?.children?.[1];
  if (list === undefined) return { root, configurations: [], ours: -1 };
  if (list.type !== 'array') return 'has a "configurations" that is not a list';
  const configurations = (list.children ?? []).map((node) => getNodeValue(node) as unknown);
  const matches = configurations.flatMap((value, index) => (isOurs(value) ? [index] : []));
  if (matches.length > 1) {
    return `has ${matches.length} "${LAUNCH_ENTRY_NAME}" configurations; keep one`;
  }
  return { root, configurations, ours: matches[0] ?? -1 };
}

function isOurs(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { name?: unknown }).name === LAUNCH_ENTRY_NAME
  );
}

function sameEntry(value: unknown, entry: LaunchEntry): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const keys = Object.keys(value).sort();
  return (
    JSON.stringify(keys) === JSON.stringify(Object.keys(entry).sort()) &&
    Object.entries(entry).every(([k, v]) => (value as Record<string, unknown>)[k] === v)
  );
}

/**
 * Adds the FlutterDeck entry, or replaces ours when it differs (another port, or a
 * command someone added). `text` undefined means no file yet.
 */
export function mergeLaunchJson(text: string | undefined, port: number): LaunchMerge {
  const entry = launchEntry(port);
  if (text === undefined) {
    const file = { version: LAUNCH_VERSION, configurations: [entry] };
    return { kind: 'changed', text: JSON.stringify(file, null, 2) + '\n' };
  }
  const before = parse(text);
  if (typeof before === 'string') return { kind: 'refused', reason: before };
  if (before.ours >= 0 && sameEntry(before.configurations[before.ours], entry)) {
    return { kind: 'unchanged' };
  }
  const hasList = hasKey(before.root);
  const path =
    before.ours >= 0
      ? ['configurations', before.ours]
      : hasList
        ? ['configurations', -1]
        : ['configurations'];
  const value = before.ours >= 0 || hasList ? entry : [entry];
  const out = setJsonValue(text, path, value, { append: before.ours < 0 && hasList });
  // Checks the edit kept every other configuration exactly; otherwise nothing is written.
  const after = parse(out);
  const expected = [...before.configurations];
  if (before.ours >= 0) expected[before.ours] = entry;
  else expected.push(entry);
  if (
    typeof after === 'string' ||
    JSON.stringify(after.configurations) !== JSON.stringify(expected)
  ) {
    return { kind: 'refused', reason: "couldn't be updated without changing other settings" };
  }
  return { kind: 'changed', text: out };
}

function hasKey(root: Node): boolean {
  return root.children?.some((prop) => prop.children?.[0]?.value === 'configurations') ?? false;
}
