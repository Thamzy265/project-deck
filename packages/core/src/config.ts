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
  );

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
