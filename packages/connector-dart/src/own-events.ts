import { performance } from 'node:perf_hooks';

/**
 * Tells our own reloads and restarts apart from other people's when the VM reports
 * both the same way. Each own action expects at most one VM signal; it is matched while
 * the action runs or within `graceMs` after its answer, because the signal and the
 * answer take different routes. A signal no own action expects is someone else's.
 */
export class OwnEvents {
  private running = 0;
  private expected = 0;
  private until = Number.POSITIVE_INFINITY;

  constructor(private readonly graceMs: number) {}

  started(): void {
    this.running++;
    this.expected++;
  }

  finished(): void {
    this.running--;
    this.until = performance.now() + this.graceMs;
  }

  /** True when the signal belongs to one of our own actions (and uses it up). */
  claim(): boolean {
    if (this.expected > 0 && this.running === 0 && performance.now() > this.until) {
      // Our actions' signals never came (e.g. nothing changed, or the tool failed early).
      this.expected = 0;
    }
    if (this.expected === 0) return false;
    this.expected--;
    return true;
  }
}
