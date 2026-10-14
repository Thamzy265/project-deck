/**
 * `.flutterdeck/config.json`: per-project settings the user may commit.
 * A missing file means DEFAULT_CONFIG. Unknown keys are rejected so a typo never
 * silently leaves a safety setting (such as masking) at a value the user didn't mean.
 */
import { z } from 'zod';

export const CONFIG_VERSION = 1;
export const MAX_REDACT_RULES = 20;
export const MAX_REDACT_RULE_LENGTH = 200;

const RedactRule = z
  .string()
  .min(1)
  .max(MAX_REDACT_RULE_LENGTH)
  .refine(
    (source) => {
      try {
        new RegExp(source);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Invalid regular expression' },
  )
  .refine((source) => !hasNestedQuantifier(source), {
    message: 'A group with a quantifier inside may not repeat (nested quantifier), e.g. (a+)+',
  });

/**
 * Finds the classic catastrophic-backtracking shape: a group that holds an open-ended
 * quantifier (`+`, `*`, `{n,}`, `{n,m}`) and is itself repeated by one. A simple scan,
 * not a full regex parser: it misses other slow patterns such as `(a|a)*`, so the
 * time budget in the masking layer stays the real guard.
 */
export function hasNestedQuantifier(source: string): boolean {
  // One flag per open group: does it contain an open-ended quantifier so far?
  const groups: boolean[] = [];
  let i = 0;
  const quantifierAt = (at: number): number => {
    const c = source[at];
    if (c === '+' || c === '*') return 1;
    if (c !== '{') return 0;
    const m = /^\{\d*,\d*\}/.exec(source.slice(at));
    return m === null ? 0 : m[0].length;
  };
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '[') {
      // Skip a character class; quantifier characters inside it are literals.
      i++;
      while (i < source.length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '(') {
      groups.push(false);
      i++;
      continue;
    }
    if (c === ')') {
      const inner = groups.pop() ?? false;
      i++;
      const outer = quantifierAt(i);
      if (inner && outer > 0) return true;
      // A repeated group or one with a quantifier inside counts for the group around it.
      if ((inner || outer > 0) && groups.length > 0) groups[groups.length - 1] = true;
      continue;
    }
    const q = quantifierAt(i);
    if (q > 0) {
      if (groups.length > 0) groups[groups.length - 1] = true;
      i += q;
      continue;
    }
    i++;
  }
  return false;
}

const NotificationsSchema = z.strictObject({
  appCrashed: z.boolean().default(true),
  reloadFailed: z.boolean().default(true),
  claudeWaiting: z.boolean().default(true),
});

const LogsConfigSchema = z.strictObject({
  /** Best-effort masking of log text sent to Claude. */
  redact: z.boolean().default(true),
  /** Extra JavaScript regular expressions whose matches are masked too. */
  rules: z.array(RedactRule).max(MAX_REDACT_RULES).default([]),
});

export const DeckConfigSchema = z.strictObject({
  version: z.literal(CONFIG_VERSION),
  /**
   * Fixed dashboard port. Below 1024 needs elevated rights on Linux and macOS,
   * which the daemon never has.
   */
  port: z.number().int().min(1024).max(65535).optional(),
  notifications: NotificationsSchema.default(() => NotificationsSchema.parse({})),
  logs: LogsConfigSchema.default(() => LogsConfigSchema.parse({})),
});
export type DeckConfig = z.infer<typeof DeckConfigSchema>;

export const DEFAULT_CONFIG: DeckConfig = DeckConfigSchema.parse({ version: CONFIG_VERSION });
