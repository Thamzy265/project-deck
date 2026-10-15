/**
 * Tester edge cases for the hook's pure parts: odd stdin shapes, tool_response shapes,
 * tool names, the reload message scrub and the project folder lookup. Inputs follow the
 * doc-built fixtures in ./fixtures.ts (code.claude.com/docs/en/hooks, 15 Oct 2026).
 */
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HookEventInput, MAX_RELOAD_MESSAGE, MAX_WAITING_MESSAGE } from '@project-deck/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as hook from '../hooks/deck-hook.mjs';
import * as fx from './fixtures.js';

const { scrubReloadMessage, scrubText, toDeckEvent, projectDirOf, readDaemonAddress } = hook;
const posix = process.platform === 'win32' ? it.skip : it;
/** In `u` mode a pair is one code point, so only a lone half matches. */
const hasLoneSurrogate = (text: string) => /\p{Cs}/u.test(text);

const reloadOf = (input: unknown) => {
  const event = toDeckEvent(input);
  return event?.type === 'claude.reload' ? event : undefined;
};

describe('toDeckEvent: stdin shapes', () => {
  it.each([
    ['a lower-case event name', { ...fx.stop, hook_event_name: 'stop' }],
    ['no event name', { session_id: 'abc123' }],
    ['an event name that is not a string', { ...fx.stop, hook_event_name: ['Stop'] }],
    ['a Notification without a type', { ...fx.permissionPrompt, notification_type: undefined }],
    ['a Notification type that is not a string', { ...fx.permissionPrompt, notification_type: 1 }],
    [
      'elicitation_url_dialog (left out by the lead)',
      { ...fx.permissionPrompt, notification_type: 'elicitation_url_dialog' },
    ],
    ['agent_completed', { ...fx.permissionPrompt, notification_type: 'agent_completed' }],
    ['a PostToolUse without a tool name', { ...fx.reloadSucceeded, tool_name: undefined }],
    ['a PreToolUse on the reload tool', { ...fx.reloadSucceeded, hook_event_name: 'PreToolUse' }],
    ['an interrupted PostToolUse', { ...fx.reloadSucceeded, is_interrupt: true }],
  ])('sends nothing for %s', (_, input) => {
    expect(toDeckEvent(input)).toBeUndefined();
  });

  it('still sends a waiting event when the message is missing, blank or not a string', () => {
    for (const message of [undefined, '', '   \n\t', 42, { text: 'x' }, null]) {
      expect(toDeckEvent({ ...fx.permissionPrompt, message })).toEqual({
        type: 'claude.waiting',
        sessionId: 'abc123',
      });
    }
  });

  it('sends a session id at exactly 128 characters, never at 129', () => {
    const at = 'a'.repeat(128);
    expect(toDeckEvent({ ...fx.stop, session_id: at })).toEqual({
      type: 'claude.done',
      sessionId: at,
    });
    expect(toDeckEvent({ ...fx.stop, session_id: `${at}a` })).toEqual({ type: 'claude.done' });
    for (const bad of ['../x', 'a\nb', 'a/b', '', 'é']) {
      expect(toDeckEvent({ ...fx.stop, session_id: bad })).toEqual({ type: 'claude.done' });
    }
  });

  it('cuts a waiting message of emoji on a character, never inside a surrogate pair', () => {
    const event = toDeckEvent({ ...fx.permissionPrompt, message: '😀'.repeat(3000) });
    const message = event?.type === 'claude.waiting' ? (event.message ?? '') : '';
    expect(Array.from(message)).toHaveLength(MAX_WAITING_MESSAGE);
    expect(message.endsWith('😀…')).toBe(true);
    expect(hasLoneSurrogate(message)).toBe(false);
    expect(HookEventInput.safeParse(event).success).toBe(true);
  });

  it('passes a waiting message with control and bidi characters on as data the schema accepts', () => {
    const message = '\u202eAllow\u0007 \u001b[31mBash\u001b[0m?\r\nrm -rf ~';
    const event = toDeckEvent({ ...fx.permissionPrompt, message });
    expect(event).toEqual({ type: 'claude.waiting', sessionId: 'abc123', message });
    expect(HookEventInput.parse(event)).toEqual(event);
  });
});

describe('toDeckEvent: tool_response shapes', () => {
  it.each([
    ['a plain string', 'Hot reload succeeded.', true],
    ['a plain failure string', 'Hot reload failed.', false],
    ['content blocks', [{ type: 'text', text: 'Hot reload succeeded.' }], true],
    [
      'content blocks with an image and a resource',
      [
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'file:///x', text: 'failed' } },
        { type: 'text', text: 'Hot reload succeeded.' },
      ],
      true,
    ],
    [
      'an object with content and isError: true',
      { content: [{ type: 'text', text: 'Hot reload failed.' }], isError: true },
      false,
    ],
    [
      'isError: true with success text',
      { content: [{ type: 'text', text: 'Hot reload succeeded.' }], isError: true },
      false,
    ],
    [
      'isError as the string "true" (not a boolean) with success text',
      { content: [{ type: 'text', text: 'Hot reload succeeded.' }], isError: 'true' },
      true,
    ],
    [
      'structured content beside the text',
      {
        content: [{ type: 'text', text: 'Hot reload failed.' }],
        structuredContent: { success: false },
      },
      false,
    ],
  ])('reads %s', (_, toolResponse, ok) => {
    const event = reloadOf({ ...fx.reloadSucceeded, tool_response: toolResponse });
    expect(event?.ok).toBe(ok);
    expect(HookEventInput.safeParse(event).success).toBe(true);
  });

  it('counts a PostToolUse with no readable result as a success (the tool did not fail)', () => {
    for (const toolResponse of [null, undefined, 42, {}, { content: 'x' }, [null, 1]]) {
      expect(reloadOf({ ...fx.reloadSucceeded, tool_response: toolResponse })).toEqual({
        type: 'claude.reload',
        sessionId: 'abc123',
        ok: true,
        kind: 'hot-reload',
      });
    }
  });

  it('reports a PostToolUseFailure whose error is missing or not a string without a message', () => {
    for (const error of [undefined, 42, { message: 'Hot reload failed: /Users/dev' }, null]) {
      expect(reloadOf({ ...fx.reloadFailed, error })).toEqual({
        type: 'claude.reload',
        sessionId: 'abc123',
        ok: false,
        kind: 'hot-reload',
      });
    }
  });

  it('never sends the failed result text of a success, only of a failure', () => {
    const event = reloadOf({
      ...fx.reloadSucceeded,
      tool_response: [{ type: 'text', text: `Hot reload succeeded on ${fx.VM_SERVICE_URI}` }],
    });
    expect(event).toEqual({
      type: 'claude.reload',
      sessionId: 'abc123',
      ok: true,
      kind: 'hot-reload',
    });
  });

  it('keeps a giant failure message within the daemon limit', () => {
    const event = reloadOf({
      ...fx.reloadFailed,
      error: `Hot reload failed: ${'x '.repeat(50_000)}`,
    });
    expect(Array.from(event?.message ?? '')).toHaveLength(MAX_RELOAD_MESSAGE);
    expect(HookEventInput.safeParse(event).success).toBe(true);
  });
});

describe('toDeckEvent: tool names', () => {
  it.each([
    'mcp__dart__hot_reload_extra',
    'mcp__dart__hot_reloadx',
    'xmcp__dart__hot_reload',
    'mcp__dart__hot_reload ',
    'mcp__dart__hot_rebuild',
    'mcp__flutterdeck__hot_reload',
    'mcp__plugin_flutterdeck_flutterdeck__hot_restart',
    'hot_reload',
    'mcp____hot_reload',
  ])('ignores %j', (tool) => {
    expect(toDeckEvent({ ...fx.reloadSucceeded, tool_name: tool })).toBeUndefined();
  });

  it('reads the kind from the tool name, not the input or result', () => {
    expect(
      reloadOf({
        ...fx.reloadSucceeded,
        tool_name: 'mcp__dart__hot_restart',
        tool_response: 'Hot reload succeeded.',
      })?.kind,
    ).toBe('hot-restart');
  });
});

describe('the hooks.json matcher and the script agree on tool names', () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'hooks.json');
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const matcher =
    typeof parsed === 'object' &&
    parsed !== null &&
    'hooks' in parsed &&
    typeof parsed.hooks === 'object' &&
    parsed.hooks !== null &&
    'PostToolUse' in parsed.hooks &&
    Array.isArray(parsed.hooks.PostToolUse)
      ? (parsed.hooks.PostToolUse as { matcher?: string }[])[0]?.matcher
      : undefined;
  const runsHook = (tool: string) => new RegExp(matcher ?? '^$').test(tool);
  const scriptSends = (tool: string) =>
    toDeckEvent({ ...fx.reloadSucceeded, tool_name: tool }) !== undefined;

  it('for lower-case names', () => {
    for (const tool of [
      'mcp__dart__hot_reload',
      'mcp__plugin_dart-flutter_dart-mcp-server__hot_restart',
      'mcp__vite__hot_reload',
      'mcp__dartboard__hot_reload',
    ]) {
      expect(runsHook(tool)).toBe(scriptSends(tool));
    }
  });

  // T-P5-5: the script matches /dart/i but the matcher is case-sensitive, so a server the
  // user named "Dart" or "DartMCP" never triggers the hook although the notes say any
  // server whose name contains dart does.
  it('T-P5-5 for a server name with capitals', () => {
    for (const tool of ['mcp__Dart__hot_reload', 'mcp__DartMCP__hot_restart']) {
      expect(scriptSends(tool)).toBe(true);
      expect(runsHook(tool)).toBe(scriptSends(tool));
    }
  });
  it('T-P5-5 agree on a table of names, with the same pattern in both', () => {
    expect(matcher).toBe(hook.RELOAD_TOOL_PATTERN);
    const table: [string, boolean][] = [
      ['mcp__dart__hot_reload', true],
      ['mcp__Dart__hot_reload', true],
      ['mcp__DART__hot_restart', true],
      ['mcp__DartMCP__hot_restart', true],
      ['mcp__plugin_flutterdeck_dart__hot_reload', true],
      ['mcp__plugin_dart-flutter_dart-mcp-server__hot_restart', true],
      ['mcp__dartboard__hot_reload', true],
      ['mcp__vite__hot_reload', false],
      ['mcp__dart__hot_reloads', false],
      ['mcp__dart__HOT_RELOAD', false],
      ['MCP__dart__hot_reload', false],
      ['mcp__dart__get_runtime_errors', false],
      ['xmcp__dart__hot_reload', false],
      ['Bash', false],
    ];
    for (const [tool, expected] of table) {
      expect(runsHook(tool), tool).toBe(expected);
      expect(scriptSends(tool), tool).toBe(expected);
    }
  });
});

describe('scrubReloadMessage: more shapes', () => {
  it.each([
    ['dart-vm-service://127.0.0.1:8181/AbC=/ ok', '[address] ok'],
    ['WS://LOCALHOST:8181/AbC=/ws', '[address]'],
    ['address=localhost:8181/AbC=/ws', 'address=[address]'],
    ['(/Users/dev/app/lib/main.dart:3)', '([path]'],
    ['"/Users/dev/x" and \'/home/dev/y\'', '"[path]" and \'[path]\''],
    ['c:/Users/dev/app', '[path]'],
  ])('scrubs %j', (input, output) => {
    expect(scrubReloadMessage(input)).toBe(output);
  });

  it('cuts emoji on a character, never inside a surrogate pair', () => {
    const out = scrubReloadMessage('😀'.repeat(1000));
    expect(Array.from(out)).toHaveLength(MAX_RELOAD_MESSAGE);
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  // T-P5-1: a VM service address on IPv6 loopback without a scheme keeps its auth code.
  // `\b` never matches before `[` after a space, so only the `/…` part goes, after the code.
  it('T-P5-1 removes an IPv6 VM service address and its auth code', () => {
    const code = randomBytes(8).toString('base64url');
    const out = scrubReloadMessage(`Hot reload failed: cannot reach [::1]:8181/${code}=/ws`);
    expect(out).not.toContain(code);
  });

  // T-P5-3: an absolute path right after a character outside the fixed list (`[`, a
  // backtick, `{`) is kept as is. So is one after a control or zero-width character: those
  // are removed only after the path pattern ran, so they hide the path from it.
  it('T-P5-3 removes absolute paths after brackets, backticks, braces or hidden characters', () => {
    for (const text of [
      'failed [/Users/dev/app/lib/main.dart:3]',
      'failed `/Users/dev/app`',
      'failed {/Users/dev/app}',
      'failed \u200b/Users/dev/app',
      'failed\u0000/Users/dev/app',
    ]) {
      expect(scrubReloadMessage(text)).not.toContain('/Users/dev');
    }
  });

  // T-P5-4: a path with a space keeps everything after the space: the user's surname in a
  // Windows profile folder, or the project folder name.
  it('T-P5-4 removes the whole of a path with a space in it', () => {
    expect(scrubReloadMessage('failed in C:\\Users\\Jane Doe\\shop\\main.dart')).not.toContain(
      'Doe',
    );
    expect(scrubReloadMessage('failed in /Users/jane/Shop App/lib/main.dart')).not.toContain(
      'lib/main.dart',
    );
  });

  // T-P5-2: the scheme pattern backtracks over every word boundary, so the scrub is
  // quadratic in the error's length. The error is scrubbed before it is cut, and stdin may
  // be 4 MB, so a long error keeps the hook busy far past its 2 s deadline (a timer can't
  // interrupt a running regular expression).
  it('T-P5-2 scrubs a 64 kB error in well under the hook deadline', () => {
    const started = performance.now();
    scrubReloadMessage(`Hot reload failed: ${'a.'.repeat(32_000)}`);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('S1 removes percent-encoded URIs, once, twice or three times encoded', () => {
    const code = randomBytes(9).toString('base64url');
    const uri = `ws://127.0.0.1:50123/${code}=/ws`;
    let encoded = uri;
    for (let times = 1; times <= 3; times++) {
      encoded = encodeURIComponent(encoded);
      for (const text of [
        `cannot reach uri=${encoded}`,
        `GET /devtools?uri=${encoded} failed`,
        `cannot reach ${encoded.toLowerCase()}`,
      ]) {
        const out = scrubReloadMessage(text);
        expect(out, `${times}: ${text}`).not.toContain(code);
        expect(out).not.toContain(code.toLowerCase());
        // Masked as an address, or inside a path that goes as a whole.
        expect(out).toMatch(/\[(address|path)\]/);
      }
    }
  });

  it('R2-2 masks what is still encoded after three rounds (fail closed)', () => {
    const code = randomBytes(9).toString('base64url');
    let encoded = `ws://127.0.0.1:50123/${code}=/ws`;
    for (let times = 0; times < 5; times++) encoded = encodeURIComponent(encoded);
    const out = scrubReloadMessage(`cannot reach uri=${encoded} now`);
    expect(out).not.toContain(code);
    expect(out).not.toMatch(/%[0-9A-Fa-f]{2}/);
    expect(out).toBe('cannot reach [address] now');
  });

  it('R2-2 leaves text with no escapes left alone', () => {
    expect(scrubReloadMessage('used 100%25 of the budget')).toBe('used 100% of the budget');
  });

  it('S1 removes host:port/… addresses for any host name', () => {
    const code = randomBytes(9).toString('base64url');
    for (const host of [
      'my-mac.local',
      'devbox',
      'build-01.corp.example.com',
      'Jane-MacBook-Pro.local',
    ]) {
      expect(scrubReloadMessage(`cannot reach ${host}:52345/${code}=/ws now`)).toBe(
        'cannot reach [address] now',
      );
    }
  });

  it('R2-4 removes host:port/… addresses whose host has an underscore', () => {
    const code = randomBytes(9).toString('base64url');
    for (const host of ['my_host', 'dev_box.local', '_gateway']) {
      expect(scrubReloadMessage(`cannot reach ${host}:5/${code} now`)).toBe(
        'cannot reach [address] now',
      );
    }
  });

  it('S1 leaves file:line:column positions alone', () => {
    expect(scrubReloadMessage('main.dart:12:3: Error: x')).toBe('main.dart:12:3: Error: x');
    expect(scrubReloadMessage('lib/main.dart:12:3 x')).toBe('lib/main.dart:12:3 x');
  });

  it('T-P5-1 removes addresses without a scheme, whole', () => {
    for (const [text, out] of [
      ['cannot reach [::1]:8181/AbC=/ws now', 'cannot reach [address] now'],
      ['cannot reach 127.0.0.1:8181/AbC=/ws', 'cannot reach [address]'],
      ['cannot reach localhost:8181/AbC=/ws', 'cannot reach [address]'],
      ['cannot reach [::1]:8181', 'cannot reach [address]'],
    ] as const) {
      expect(scrubReloadMessage(text)).toBe(out);
    }
  });

  it('T-P5-2 cuts the raw error before it scrubs, so a path past the cut never matters', () => {
    const out = scrubReloadMessage(`${'x '.repeat(2000)}/Users/dev/secret`);
    expect(out).not.toContain('/Users');
    expect(Array.from(out)).toHaveLength(MAX_RELOAD_MESSAGE);
  });

  it('T-P5-2 scrubs a 4 MB error in well under the hook deadline', () => {
    for (const unit of [
      'a.',
      'a:',
      '/',
      'a:/',
      '[::',
      '1.1.1.',
      'C:\\',
      'aa://',
      '%25',
      'a.b:1/',
    ]) {
      const started = performance.now();
      scrubReloadMessage(`Hot reload failed: ${unit.repeat(4_000_000 / unit.length)}`);
      expect(performance.now() - started, unit).toBeLessThan(500);
    }
  });

  it('T-P5-2 every pattern grows linearly with the text (scrubText, before the cut)', () => {
    const best = (text: string) => {
      let min = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        scrubText(text);
        min = Math.min(min, performance.now() - started);
      }
      return Math.max(min, 0.05);
    };
    for (const unit of [
      'a.',
      'a:',
      '/',
      'a:/',
      '[::',
      '1.1.1.',
      'C:\\',
      'aa://',
      'x ',
      '%25',
      '%3A%2F',
      'a.b:1/',
      'a-',
    ]) {
      const small = best(unit.repeat(20_000));
      const large = best(unit.repeat(160_000));
      // 8 times the text: linear is about 8, quadratic about 64.
      expect(large / small, unit).toBeLessThan(24);
    }
  });
});

describe('projectDirOf: more inputs', () => {
  const abs = process.platform === 'win32' ? 'C:\\proj' : '/proj';
  const cwd = process.platform === 'win32' ? 'C:\\cwd' : '/cwd';

  it('uses the working folder when CLAUDE_PROJECT_DIR is empty or relative', () => {
    expect(projectDirOf({ CLAUDE_PROJECT_DIR: '' }, { cwd })).toBe(cwd);
    expect(projectDirOf({ CLAUDE_PROJECT_DIR: '.' }, { cwd })).toBe(cwd);
    expect(projectDirOf({ CLAUDE_PROJECT_DIR: 'proj' }, { cwd })).toBe(cwd);
  });

  it('keeps CLAUDE_PROJECT_DIR even when cwd differs (a subfolder or a worktree)', () => {
    expect(projectDirOf({ CLAUDE_PROJECT_DIR: abs }, { cwd: join(abs, 'lib') })).toBe(abs);
  });

  it('gives nothing for a cwd that is not an absolute string', () => {
    for (const bad of [undefined, 42, ['/x'], '', 'lib']) {
      expect(projectDirOf({}, { cwd: bad })).toBeUndefined();
    }
    expect(projectDirOf({}, '/proj')).toBeUndefined();
    expect(projectDirOf({}, ['/proj'])).toBeUndefined();
  });
});

describe('readDaemonAddress: odd project folders', () => {
  let dir: string;
  const token = () => randomBytes(24).toString('hex');
  const state = (...parts: string[]) => join(dir, '.flutterdeck', ...parts);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'deck-hook-edges-'));
    await mkdir(state());
    await writeFile(state('config.json'), '{"version":1}');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const runtime = (body: unknown) => writeFile(state('runtime.json'), JSON.stringify(body));

  it('reads a good runtime.json', async () => {
    const t = token();
    await runtime({ pid: 1, port: 9147, token: t, startedAt: 1 });
    expect(await readDaemonAddress(dir)).toEqual({ port: 9147, token: t });
  });

  it.each([
    ['a port as a string', { port: '9147' }],
    ['port 0', { port: 0 }],
    ['port 65536', { port: 65536 }],
    ['a fractional port', { port: 9147.5 }],
    ['a negative port', { port: -1 }],
  ])('refuses %s', async (_, fields) => {
    await runtime({ pid: 1, token: token(), startedAt: 1, ...fields });
    expect(await readDaemonAddress(dir)).toBeUndefined();
  });

  it.each([
    ['31 characters', () => 'a'.repeat(31)],
    ['513 characters', () => 'a'.repeat(513)],
    ['a space', () => `${token()} x`],
    ['a non-ASCII character', () => `${token()}é`],
    ['a number', () => 1234567890],
  ])('refuses a token with %s', async (_, make) => {
    await runtime({ pid: 1, port: 9147, token: make(), startedAt: 1 });
    expect(await readDaemonAddress(dir)).toBeUndefined();
  });

  it('accepts tokens at exactly 32 and 512 characters', async () => {
    for (const t of ['b'.repeat(32), 'c'.repeat(512)]) {
      await runtime({ pid: 1, port: 9147, token: t, startedAt: 1 });
      expect(await readDaemonAddress(dir)).toEqual({ port: 9147, token: t });
    }
  });

  it('refuses JSON that is not an object', async () => {
    for (const body of [null, [9147], 'x', 1]) {
      await runtime(body);
      expect(await readDaemonAddress(dir)).toBeUndefined();
    }
  });

  it('refuses a runtime.json over 64 kB', async () => {
    await runtime({ pid: 1, port: 9147, token: token(), pad: 'x'.repeat(70_000) });
    expect(await readDaemonAddress(dir)).toBeUndefined();
  });

  it('refuses runtime.json or config.json when it is a folder', async () => {
    await mkdir(state('runtime.json'));
    expect(await readDaemonAddress(dir)).toBeUndefined();
    await rm(state('runtime.json'), { recursive: true });
    await runtime({ pid: 1, port: 9147, token: token(), startedAt: 1 });
    await rm(state('config.json'));
    await mkdir(state('config.json'));
    expect(await readDaemonAddress(dir)).toBeUndefined();
  });

  it('does nothing when .flutterdeck is a file', async () => {
    await rm(state(), { recursive: true });
    await writeFile(state(), '{}');
    expect(await readDaemonAddress(dir)).toBeUndefined();
  });

  posix('refuses a linked config.json', async () => {
    await runtime({ pid: 1, port: 9147, token: token(), startedAt: 1 });
    const real = join(dir, 'real-config.json');
    await writeFile(real, '{"version":1}');
    await rm(state('config.json'));
    await symlink(real, state('config.json'));
    expect(await readDaemonAddress(dir)).toBeUndefined();
  });

  posix('never blocks on a FIFO at runtime.json', async () => {
    execFileSync('mkfifo', [state('runtime.json')]);
    expect(await readDaemonAddress(dir)).toBeUndefined();
  });

  posix('finds the project through a linked project folder (cwd with a symlink)', async () => {
    const t = token();
    await runtime({ pid: 1, port: 9147, token: t, startedAt: 1 });
    const linkParent = await mkdtemp(join(tmpdir(), 'deck-hook-link-'));
    try {
      const linked = join(linkParent, 'proj');
      await symlink(dir, linked, 'dir');
      expect(await readDaemonAddress(linked)).toEqual({ port: 9147, token: t });
    } finally {
      await rm(linkParent, { recursive: true, force: true });
    }
  });

  it('does nothing from a subfolder of the project (it never walks up)', async () => {
    await runtime({ pid: 1, port: 9147, token: token(), startedAt: 1 });
    await mkdir(join(dir, 'lib'));
    expect(await readDaemonAddress(join(dir, 'lib'))).toBeUndefined();
  });
});
