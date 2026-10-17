/**
 * At most one call per key per window (ADR 0004, amended: one re-query per table per
 * 250 ms). The first event fires at once so a new row shows fast; events inside the
 * window fold into one trailing call at its end.
 */
export class Coalescer {
  private readonly windows = new Map<string, { timer: NodeJS.Timeout; pending: boolean }>();

  constructor(private readonly windowMs: number) {}

  fire(key: string, run: () => void): void {
    const open = this.windows.get(key);
    if (open !== undefined) {
      open.pending = true;
      return;
    }
    run();
    this.open(key, run);
  }

  private open(key: string, run: () => void): void {
    const window = { pending: false, timer: setTimeout(() => this.close(key, run), this.windowMs) };
    window.timer.unref();
    this.windows.set(key, window);
  }

  private close(key: string, run: () => void): void {
    const window = this.windows.get(key);
    this.windows.delete(key);
    if (window?.pending !== true) return;
    run();
    this.open(key, run);
  }

  clear(): void {
    for (const { timer } of this.windows.values()) clearTimeout(timer);
    this.windows.clear();
  }
}
