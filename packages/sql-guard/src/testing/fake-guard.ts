import type { SqlGuard } from '../guard.js';
import type { GuardCheckOptions, GuardRefusal, GuardResult } from '../types.js';

const PASS: GuardResult = { ok: true, kind: 'select', tables: [], functions: [], recursive: false };

/**
 * A programmable gate for tests of the backends, daemon and MCP server. It judges
 * nothing: verdicts come from `refuse()`, `answer()` or the fallback.
 */
export class FakeSqlGuard implements SqlGuard {
  readonly calls: { sql: string; opts: GuardCheckOptions }[] = [];
  closed = false;
  private readonly verdicts = new Map<string, GuardResult>();

  constructor(
    private readonly fallback: (sql: string, opts: GuardCheckOptions) => GuardResult = () => PASS,
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
