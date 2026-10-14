import { describe, expect, it } from 'vitest';
import { ACTIVITY_CAPACITY, ActivityEntrySchema, ActivityListSchema } from './activity.js';

describe('ActivityEntrySchema', () => {
  it('accepts every kind of entry', () => {
    const entries = [
      { id: 1, ts: 1, kind: 'app.attached', appId: 'a', appName: 'shop' },
      { id: 2, ts: 2, kind: 'app.detached', appId: 'a', appName: 'shop' },
      {
        id: 3,
        ts: 3,
        kind: 'app.reloaded',
        appId: 'a',
        appName: 'shop',
        result: { ok: true, kind: 'hot-reload', durationMs: 180 },
      },
      { id: 4, ts: 4, kind: 'app.stopped', appId: 'a', appName: 'shop' },
      { id: 5, ts: 5, kind: 'app.crashed', appId: 'a', appName: 'shop', code: 1 },
      { id: 6, ts: 6, kind: 'claude.done', sessionId: 's' },
      { id: 7, ts: 7, kind: 'claude.waiting', message: 'Allow edit?' },
    ];
    for (const entry of entries) expect(ActivityEntrySchema.parse(entry)).toEqual(entry);
    expect(ActivityListSchema.parse({ entries })).toEqual({ entries });
  });

  it('rejects unknown kinds and over-long waiting messages', () => {
    expect(ActivityEntrySchema.safeParse({ id: 1, ts: 1, kind: 'claude.typing' }).success).toBe(
      false,
    );
    expect(
      ActivityEntrySchema.safeParse({
        id: 1,
        ts: 1,
        kind: 'claude.waiting',
        message: 'x'.repeat(2001),
      }).success,
    ).toBe(false);
  });

  it('never carries the assistant message from a Stop hook', () => {
    const parsed = ActivityEntrySchema.parse({
      id: 1,
      ts: 1,
      kind: 'claude.done',
      last_assistant_message: 'secret plan',
    });
    expect(parsed).not.toHaveProperty('last_assistant_message');
  });

  it('keeps 500 entries', () => {
    expect(ACTIVITY_CAPACITY).toBe(500);
  });
});
