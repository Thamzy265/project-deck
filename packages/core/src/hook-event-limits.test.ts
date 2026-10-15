/**
 * Regression lock: the plugin hook cuts messages by characters (code points, Array.from),
 * so the daemon's schema must count the same way. If zod ever counted UTF-16 units, a cut
 * emoji message would be refused with 400 and the event lost.
 */
import { describe, expect, it } from 'vitest';
import { ActivityEntrySchema, MAX_RELOAD_MESSAGE, MAX_WAITING_MESSAGE } from './activity.js';
import { HookEventInput } from './api.js';

const emoji = (n: number) => '😀'.repeat(n);

describe('hook event limits count characters, as the hook cuts them', () => {
  it('a waiting message of 2000 emoji is accepted, 2001 is not', () => {
    expect(
      HookEventInput.safeParse({ type: 'claude.waiting', message: emoji(MAX_WAITING_MESSAGE) })
        .success,
    ).toBe(true);
    expect(
      HookEventInput.safeParse({ type: 'claude.waiting', message: emoji(MAX_WAITING_MESSAGE + 1) })
        .success,
    ).toBe(false);
  });

  it('a reload message of 300 emoji is accepted by the input and the stored entry', () => {
    const message = emoji(MAX_RELOAD_MESSAGE);
    expect(
      HookEventInput.safeParse({ type: 'claude.reload', ok: false, kind: 'hot-reload', message })
        .success,
    ).toBe(true);
    const entry = {
      id: 1,
      ts: 1,
      kind: 'claude.reload',
      ok: false,
      reload: 'hot-reload',
      message,
    };
    expect(ActivityEntrySchema.safeParse(entry).success).toBe(true);
    expect(ActivityEntrySchema.safeParse({ ...entry, message: `${message}😀` }).success).toBe(
      false,
    );
  });

  it('a stored claude.reload entry needs ok and a known reload kind', () => {
    const base = { id: 1, ts: 1, kind: 'claude.reload' };
    expect(ActivityEntrySchema.safeParse({ ...base, reload: 'hot-reload' }).success).toBe(false);
    expect(ActivityEntrySchema.safeParse({ ...base, ok: true, reload: 'rebuild' }).success).toBe(
      false,
    );
    expect(
      ActivityEntrySchema.safeParse({
        ...base,
        ok: true,
        reload: 'hot-restart',
        sessionId: 'x'.repeat(129),
      }).success,
    ).toBe(false);
  });
});
