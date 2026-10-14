/**
 * The one place text is masked before it reaches Claude (design D4): every string in
 * a tool's output goes through `mask` before the output is truncated or sent.
 */
import { maskBuiltIn } from './builtins.js';
import { UserRuleRunner } from './user-rules.js';

/** Each text is cut to this many characters before any pattern runs. */
export const MAX_TEXT = 4096;
export const CUT_MARKER = ' …[cut]';
export const MASKING_OFF = 'Masking for Claude is off';
export const RULES_SKIPPED = 'Some masking rules were skipped (too slow)';

export type JsonValue =
  string | number | boolean | null | undefined | JsonValue[] | { [key: string]: JsonValue };

export interface MaskSettings {
  /** `logs.redact` from the project config. */
  redact: boolean;
  /** `logs.rules` from the project config, already validated. */
  rules: readonly string[];
}

export interface Masked<T> {
  value: T;
  /** Lines to show with the output, such as "Masking for Claude is off". */
  notes: string[];
}

export class Masker {
  private readonly userRules: UserRuleRunner;

  constructor(private readonly settings: MaskSettings) {
    this.userRules = new UserRuleRunner(settings.redact ? settings.rules : []);
  }

  get redact(): boolean {
    return this.settings.redact;
  }

  /** Starts the user-rule worker early, so the first call has its whole budget. */
  ready(): Promise<void> {
    return this.userRules.ready();
  }

  async mask<T extends JsonValue>(value: T): Promise<Masked<T>> {
    const texts: string[] = [];
    collect(value, texts);
    const cut = texts.map(cutText);
    if (!this.settings.redact) {
      return { value: rebuild(value, cut.values()) as T, notes: [MASKING_OFF] };
    }
    const result = await this.userRules.run(cut.map(maskBuiltIn));
    return {
      value: rebuild(value, result.texts.values()) as T,
      notes: result.skipped ? [RULES_SKIPPED] : [],
    };
  }

  close(): Promise<void> {
    return this.userRules.close();
  }
}

function cutText(text: string): string {
  if (text.length <= MAX_TEXT) return text;
  let end = MAX_TEXT;
  // Don't leave half of a surrogate pair at the end.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(0, end) + CUT_MARKER;
}

function collect(value: JsonValue, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collect(item, out);
  else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) collect(item, out);
  }
}

/** The same walk as `collect`, taking the replacement texts in the same order. */
function rebuild(value: JsonValue, texts: Iterator<string>): JsonValue {
  if (typeof value === 'string') {
    const next = texts.next();
    return next.done === true ? value : next.value;
  }
  if (Array.isArray(value)) return value.map((item) => rebuild(item, texts));
  if (typeof value === 'object' && value !== null) {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value)) out[key] = rebuild(item, texts);
    return out;
  }
  return value;
}
