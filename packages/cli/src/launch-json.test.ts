import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { LAUNCH_ENTRY_NAME, launchEntry, mergeLaunchJson } from './launch-json.js';

function changed(text: string | undefined, port = 9147): string {
  const result = mergeLaunchJson(text, port);
  if (result.kind !== 'changed') throw new Error(`expected a change, got ${result.kind}`);
  return result.text;
}

describe('launchEntry', () => {
  it('is attach-only: the origin alone, with the matching port and no command', () => {
    expect(launchEntry(9148)).toEqual({
      name: LAUNCH_ENTRY_NAME,
      url: 'http://127.0.0.1:9148',
      port: 9148,
    });
  });
});

describe('mergeLaunchJson', () => {
  it('creates the file with the version Claude Desktop uses', () => {
    expect(JSON.parse(changed(undefined))).toEqual({
      version: '0.0.1',
      configurations: [launchEntry(9147)],
    });
  });

  it('appends the entry and keeps other configurations and comments', () => {
    const text = [
      '{',
      '  // Dev servers for this repo',
      '  "version": "0.0.1",',
      '  "configurations": [',
      '    /* the web app */',
      '    { "name": "web", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": 3000 },',
      '  ],',
      '}',
      '',
    ].join('\n');
    const out = changed(text);
    expect(out).toContain('// Dev servers for this repo');
    expect(out).toContain('/* the web app */');
    // The neighbour keeps its own layout.
    expect(out).toContain(
      '    { "name": "web", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": 3000 },',
    );
    const value = parse(out) as { configurations: unknown[] };
    expect(value.configurations).toEqual([
      { name: 'web', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'], port: 3000 },
      launchEntry(9147),
    ]);
  });

  it('adds configurations when the file has none', () => {
    const out = changed('{ "version": "0.0.1" }\n');
    expect(parse(out)).toEqual({ version: '0.0.1', configurations: [launchEntry(9147)] });
  });

  it('updates its own entry in place, once', () => {
    const text = JSON.stringify(
      {
        version: '0.0.1',
        configurations: [
          { name: 'web', url: 'http://localhost:3000' },
          { name: 'FlutterDeck', url: 'http://127.0.0.1:9147', port: 9147 },
        ],
      },
      null,
      2,
    );
    const out = changed(text, 9150);
    const value = parse(out) as { configurations: unknown[] };
    expect(value.configurations).toEqual([
      { name: 'web', url: 'http://localhost:3000' },
      launchEntry(9150),
    ]);
  });

  it('replaces a FlutterDeck entry that would start a command', () => {
    const text = JSON.stringify({
      configurations: [{ name: 'FlutterDeck', runtimeExecutable: 'sh', port: 9147 }],
    });
    expect(parse(changed(text))).toEqual({ configurations: [launchEntry(9147)] });
  });

  it('changes nothing when the entry is already right (idempotent)', () => {
    const once = changed(undefined);
    expect(mergeLaunchJson(once, 9147)).toEqual({ kind: 'unchanged' });
  });

  it('keeps tab indentation and Windows line endings', () => {
    const text = '{\r\n\t"version": "0.0.1",\r\n\t"configurations": []\r\n}\r\n';
    const out = changed(text);
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
    expect(out).toContain('\t"configurations"');
  });

  it.each([
    ['not JSON', '{ "configurations": [ '],
    ['an array', '[]'],
    ['configurations not a list', '{ "configurations": {} }'],
    [
      'two FlutterDeck entries',
      '{ "configurations": [{"name":"FlutterDeck"},{"name":"FlutterDeck"}] }',
    ],
  ])('refuses a file that is %s, without quoting it', (_label, text) => {
    const result = mergeLaunchJson(text, 9147);
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).not.toContain(text);
  });
});
