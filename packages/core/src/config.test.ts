import { describe, expect, it } from 'vitest';
import { CONFIG_VERSION, DEFAULT_CONFIG, DeckConfigSchema, MAX_REDACT_RULES } from './config.js';

describe('DeckConfigSchema', () => {
  it('fills defaults from a version-only file', () => {
    expect(DeckConfigSchema.parse({ version: 1 })).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG).toEqual({
      version: CONFIG_VERSION,
      notifications: { appCrashed: true, reloadFailed: true, claudeWaiting: true },
      logs: { redact: true, rules: [] },
      db: { allowWrites: false, hiddenColumns: [] },
    });
  });

  it('accepts a full config', () => {
    const full = {
      version: 1,
      port: 9148,
      notifications: { appCrashed: false, reloadFailed: true, claudeWaiting: false },
      logs: { redact: false, rules: ['user-\\d+'] },
      db: { allowWrites: false, hiddenColumns: ['users.email'] },
    };
    expect(DeckConfigSchema.parse(full)).toEqual(full);
  });

  it('fills missing keys inside a partial section', () => {
    const parsed = DeckConfigSchema.parse({ version: 1, notifications: { appCrashed: false } });
    expect(parsed.notifications).toEqual({
      appCrashed: false,
      reloadFailed: true,
      claudeWaiting: true,
    });
  });

  it('rejects unknown keys at every level', () => {
    for (const bad of [
      { version: 1, extra: true },
      { version: 1, notifications: { claudeDone: true } },
      { version: 1, logs: { redact: true, mask: [] } },
    ]) {
      expect(DeckConfigSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('requires a known version', () => {
    expect(DeckConfigSchema.safeParse({}).success).toBe(false);
    expect(DeckConfigSchema.safeParse({ version: 2 }).success).toBe(false);
  });

  it('accepts only unprivileged ports', () => {
    for (const port of [1023, 65536, 0, 9147.5, -1]) {
      expect(DeckConfigSchema.safeParse({ version: 1, port }).success).toBe(false);
    }
    expect(DeckConfigSchema.parse({ version: 1, port: 1024 }).port).toBe(1024);
    expect(DeckConfigSchema.parse({ version: 1, port: 65535 }).port).toBe(65535);
  });

  it('limits masking rules in number, length and syntax', () => {
    const rules = (list: string[]) =>
      DeckConfigSchema.safeParse({ version: 1, logs: { rules: list } });
    expect(rules(Array.from({ length: MAX_REDACT_RULES }, (_, i) => `r${i}`)).success).toBe(true);
    expect(rules(Array.from({ length: MAX_REDACT_RULES + 1 }, (_, i) => `r${i}`)).success).toBe(
      false,
    );
    expect(rules(['a'.repeat(201)]).success).toBe(false);
    expect(rules(['']).success).toBe(false);
    expect(rules(['(unclosed']).success).toBe(false);
  });

  it.each(['(a+)+b', '(a*)*', '(\\w+){2,}', '((a+))+', '(?:x+|y)*', '(a{2,})+'])(
    'rejects the nested quantifier in %s',
    (rule) => {
      const result = DeckConfigSchema.safeParse({ version: 1, logs: { rules: [rule] } });
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain('nested quantifier');
    },
  );

  it.each([
    'user-\\d+',
    '(ab)+',
    'a+b+',
    '(a|b)*',
    '(a+)?',
    '(a+)b+',
    '[(a+)]+',
    '\\(a+\\)+',
    '(?:x+)y',
    '(a{2})+',
    '(?<id>\\d+)-x',
    '(a\\+)+',
  ])('accepts %s', (rule) => {
    expect(DeckConfigSchema.safeParse({ version: 1, logs: { rules: [rule] } }).success).toBe(true);
  });
});
