import {
  HookEventInput,
  MAX_RELOAD_MESSAGE,
  MAX_SESSION_ID,
  MAX_WAITING_MESSAGE,
  TOKEN_HEADER,
} from '@project-deck/core';
import { describe, expect, it } from 'vitest';
import * as hook from '../hooks/deck-hook.mjs';
import * as fx from './fixtures.js';

const { scrubReloadMessage, toDeckEvent, projectDirOf } = hook;

describe('toDeckEvent', () => {
  it.each([
    ['Stop', fx.stop],
    ['SubagentStop', fx.subagentStop],
  ])('turns %s into claude.done with the session id only', (_, input) => {
    expect(toDeckEvent(input)).toEqual({ type: 'claude.done', sessionId: 'abc123' });
  });

  it.each([
    ['permission_prompt', fx.permissionPrompt, 'Claude needs your permission to use Bash'],
    ['idle_prompt', fx.idlePrompt, 'Claude is waiting for your input'],
  ])('turns a %s notification into claude.waiting', (_, input, message) => {
    expect(toDeckEvent(input)).toEqual({ type: 'claude.waiting', sessionId: 'abc123', message });
  });

  it.each(['elicitation_dialog', 'agent_needs_input'])(
    'also treats a %s notification as Claude waiting for you',
    (type) => {
      expect(toDeckEvent({ ...fx.permissionPrompt, notification_type: type })).toEqual({
        type: 'claude.waiting',
        sessionId: 'abc123',
        message: 'Claude needs your permission to use Bash',
      });
    },
  );

  it('ignores other notifications', () => {
    expect(toDeckEvent(fx.authSuccess)).toBeUndefined();
    for (const type of ['elicitation_complete', 'elicitation_response', 'agent_completed']) {
      expect(toDeckEvent({ ...fx.permissionPrompt, notification_type: type })).toBeUndefined();
    }
    expect(toDeckEvent({ ...fx.permissionPrompt, notification_type: undefined })).toBeUndefined();
  });

  it('turns a successful hot_reload or hot_restart into claude.reload ok', () => {
    expect(toDeckEvent(fx.reloadSucceeded)).toEqual({
      type: 'claude.reload',
      sessionId: 'abc123',
      ok: true,
      kind: 'hot-reload',
    });
    expect(toDeckEvent(fx.restartSucceeded)).toEqual({
      type: 'claude.reload',
      sessionId: 'abc123',
      ok: true,
      kind: 'hot-restart',
    });
  });

  it('turns a failed reload into claude.reload with a scrubbed message', () => {
    expect(toDeckEvent(fx.reloadFailed)).toEqual({
      type: 'claude.reload',
      sessionId: 'abc123',
      ok: false,
      kind: 'hot-reload',
      message: 'RPCError: connection to [address] closed while compiling [path]',
    });
    // "Hot restart failed." says nothing the Activity row doesn't: no message.
    expect(toDeckEvent(fx.restartFailedOtherPlugin)).toEqual({
      type: 'claude.reload',
      sessionId: 'abc123',
      ok: false,
      kind: 'hot-restart',
    });
    expect(toDeckEvent(fx.reloadFailedAsPostToolUse)).toEqual({
      type: 'claude.reload',
      sessionId: 'abc123',
      ok: false,
      kind: 'hot-reload',
    });
  });

  it('QA F-B5-1 keeps the first line of a real Dart MCP error, without "Hot reload failed:"', () => {
    expect(toDeckEvent(fx.reloadRejected)).toEqual({
      type: 'claude.reload',
      sessionId: 'abc123',
      ok: false,
      kind: 'hot-reload',
      message: 's1.reloadSources: (-32000) Unable to reload sources: (-32603)',
    });
  });

  it.each([
    ['Hot reload failed: x', 'x'],
    ['hot RESTART failed - y', 'hot RESTART failed - y'],
    ['Hot restart failed:   y\nz', 'y'],
    ['\n\nHot reload failed: first real line\nsecond', 'first real line'],
    ['Hot reload failed.\r\nmore', undefined],
    ['Error: Hot reload failed: x', 'Error: Hot reload failed: x'],
  ])('QA F-B5-1 reads %j as %j', (error, message) => {
    const event = toDeckEvent({ ...fx.reloadFailed, error });
    expect(event).toEqual({
      type: 'claude.reload',
      sessionId: 'abc123',
      ok: false,
      kind: 'hot-reload',
      ...(message === undefined ? {} : { message }),
    });
  });

  it('ignores interrupted calls, other tools and other servers', () => {
    expect(toDeckEvent(fx.reloadInterrupted)).toBeUndefined();
    expect(toDeckEvent(fx.otherMcpTool)).toBeUndefined();
    expect(toDeckEvent(fx.notDartReload)).toBeUndefined();
    expect(toDeckEvent({ ...fx.reloadSucceeded, tool_name: 'Bash' })).toBeUndefined();
  });

  it('ignores unknown events and anything that is not an object', () => {
    for (const input of [null, 1, 'Stop', [], {}, { hook_event_name: 'PreToolUse' }]) {
      expect(toDeckEvent(input)).toBeUndefined();
    }
  });

  it.each([
    ['too long', 'a'.repeat(MAX_SESSION_ID + 1)],
    ['with a slash', '../x'],
    ['with a space', 'a b'],
    ['not a string', 42],
  ])('leaves out a session id %s', (_, sessionId) => {
    expect(toDeckEvent({ ...fx.stop, session_id: sessionId })).toEqual({ type: 'claude.done' });
  });

  it('cuts a long waiting message to the daemon limit', () => {
    const event = toDeckEvent({ ...fx.permissionPrompt, message: 'x'.repeat(5000) });
    expect(event?.type === 'claude.waiting' ? event.message : undefined).toHaveLength(
      MAX_WAITING_MESSAGE,
    );
  });

  it.each(Object.entries(fx).filter(([, v]) => typeof v === 'object'))(
    'never forwards a forbidden field or the tool input (%s)',
    (_, input) => {
      const event = toDeckEvent(input);
      if (event === undefined) return;
      const text = JSON.stringify(event);
      for (const needle of [
        fx.SECRET_ASSISTANT_TEXT,
        '.jsonl',
        '/Users/dev',
        'AbCdEf123',
        'last_assistant_message',
        'transcript_path',
        'cwd',
        'tool_input',
        'appUri',
        'permission_mode',
      ]) {
        expect(text).not.toContain(needle);
      }
      // What it sends is exactly what the daemon's schema accepts, nothing more.
      expect(HookEventInput.parse(event)).toEqual(event);
    },
  );
});

describe('scrubReloadMessage', () => {
  it.each([
    ['ws://127.0.0.1:1234/AbC=/ws failed', '[address] failed'],
    ['at http://localhost:8181/x?y=1 now', 'at [address] now'],
    ['127.0.0.1:52345/AbCdEf=/ws gone', '[address] gone'],
    ['in C:\\Users\\dev\\app\\lib\\main.dart:3', 'in [path]'],
    ['in /home/dev/app/lib/main.dart:3:5', 'in [path]'],
    ['see ~/app/x.dart', 'see [path]'],
    ['share \\\\server\\dev\\x', 'share [path]'],
    ['file:///Users/dev/app/main.dart', '[address]'],
    ['package:shop/main.dart stays', 'package:shop/main.dart stays'],
    ['lib/main.dart:3 stays', 'lib/main.dart:3 stays'],
    ['tabs\tand\u0000nul\u202e', 'tabs and nul'],
    ['first line\nsecond line', 'first line'],
  ])('scrubs %j', (input, output) => {
    expect(scrubReloadMessage(input)).toBe(output);
  });

  it('cuts to the daemon limit', () => {
    const out = scrubReloadMessage('x '.repeat(1000));
    expect(Array.from(out)).toHaveLength(MAX_RELOAD_MESSAGE);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('projectDirOf', () => {
  it("prefers Claude Code's project folder, then the hook's working folder", () => {
    const abs = process.platform === 'win32' ? 'C:\\proj' : '/proj';
    const cwd = process.platform === 'win32' ? 'C:\\cwd' : '/cwd';
    expect(projectDirOf({ CLAUDE_PROJECT_DIR: abs }, { cwd })).toBe(abs);
    expect(projectDirOf({}, { cwd })).toBe(cwd);
    expect(projectDirOf({ CLAUDE_PROJECT_DIR: 'relative' }, { cwd: 'also-relative' })).toBe(
      undefined,
    );
    expect(projectDirOf({}, null)).toBeUndefined();
  });
});

describe('limits', () => {
  it("match the daemon's schema and header", () => {
    expect(hook.MAX_WAITING_MESSAGE).toBe(MAX_WAITING_MESSAGE);
    expect(hook.MAX_RELOAD_MESSAGE).toBe(MAX_RELOAD_MESSAGE);
    expect(hook.MAX_SESSION_ID).toBe(MAX_SESSION_ID);
    expect(hook.TOKEN_HEADER).toBe(TOKEN_HEADER);
  });
});
