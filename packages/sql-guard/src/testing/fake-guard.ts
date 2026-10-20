import type { SqlGuard } from '../guard.js';
import type { GuardCheckOptions, GuardRefusal, GuardResult } from '../types.js';

const PASS: GuardResult = { ok: true, kind: 'select', tables: [], functions: [], recursive: false };

/** The target of a plain INSERT, UPDATE or DELETE: a test's stand-in for the real gate's answer. */
const EDIT_TARGET =
  /^\s*(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(\w+)"?/i;

/** Passes reads; in write mode passes a plain edit of one table, as the real gate's verdict would name it. */
function defaultVerdict(sql: string, opts: GuardCheckOptions): GuardResult {
  if (opts.mode !== 'write') return PASS;
  const table = EDIT_TARGET.exec(sql)?.[1];
  if (table === undefined) {
    return { ok: false, code: 'not-an-edit', reason: 'Not an edit of one table.' };
  }
  return {
    ok: true,
    kind: 'write',
    tables: [table],
    written: [table],
    functions: [],
    recursive: false,
  };
}

/**
 * A programmable gate for tests of the backends, daemon and MCP server. It judges
 * nothing: verdicts come from `refuse()`, `answer()` or the fallback.
 */
export class FakeSqlGuard implements SqlGuard {
  readonly calls: { sql: string; opts: GuardCheckOptions }[] = [];
  closed = false;
  private readonly verdicts = new Map<string, GuardResult>();

  constructor(
    private readonly fallback: (
      sql: string,
      opts: GuardCheckOptions,
    ) => GuardResult = defaultVerdict,
  ) {}

  /** Refuses this exact SQL. */
  refuse(sql: string, code: GuardRefusal['code'], reason: string): this {
    this.verdicts.set(sql, { ok: false, code, reason });
    return this;
  }

  /** Answers this exact SQL with the given verdict. */
  answer(sql: string, verdict: GuardResult): this {
    this.verdicts.set(sql, verdict);
    return this;
  }

  check(sql: string, opts: GuardCheckOptions): Promise<GuardResult> {
    this.calls.push({ sql, opts });
    if (this.closed) {
      return Promise.resolve({ ok: false, code: 'unavailable', reason: 'The SQL gate is closed.' });
    }
    return Promise.resolve(this.verdicts.get(sql) ?? this.fallback(sql, opts));
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}
