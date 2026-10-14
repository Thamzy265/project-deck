/**
 * The one place text is masked before it reaches Claude (design D4): every string in
 * a tool's output goes through `mask` before the output is truncated or sent.
 */
import { maskBuiltIn } from './builtins.js';
import { UserRuleRunner } from './user-rules.js';

/**
 * Each text is cut to this many characters after the built-ins ran (so a value across
 * the cut is masked whole) and before the user rules run (which have a time budget).
 */
export const MAX_TEXT = 4096;
/** The built-ins only look this far into a text: they are linear, but not free. */
export const MAX_SCAN = 65_536;
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

  get closed(): boolean {
    return this.userRules.closed;
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
    if (!this.settings.redact) {
      const cut = texts.map((t) => cutText(t, MAX_TEXT));
      return { value: rebuild(value, cut.values()) as T, notes: [MASKING_OFF] };
    }
    const masked = texts.map((t) => cutText(maskBuiltIn(cutText(t, MAX_SCAN)), MAX_TEXT));
    const result = await this.userRules.run(masked);
    return {
      value: rebuild(value, result.texts.values()) as T,
      notes: result.skipped ? [RULES_SKIPPED] : [],
    };
  }

  close(): Promise<void> {
    return this.userRules.close();
  }
}

const BUILT_IN_MARKER = /^\[(?:email|phone|token|secret|auth code) masked\]/;

/** Cuts `text` to at most `max` characters, never inside a surrogate pair or a marker. */
function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  // A marker has no '[' inside, so one across the cut starts at the last '[' before it.
  const open = text.lastIndexOf('[', end - 1);
  if (open !== -1) {
    const marker = BUILT_IN_MARKER.exec(text.slice(open, open + 32));
    if (marker !== null && open + marker[0].length > end) end = open;
  }
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
