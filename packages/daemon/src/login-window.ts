/** How long the dashboard cookie may be handed out after a window opens (ADR 0003). */
export const LOGIN_WINDOW_MS = 2 * 60 * 1000;

/**
 * When `GET /` may hand out the dashboard cookie: for 2 minutes after the daemon starts
 * or after someone holding the runtime.json token asks. Kept as a timestamp, so there
 * is no timer to clear.
 */
export class LoginWindow {
  private until = Number.NEGATIVE_INFINITY;

  constructor(private readonly now: () => number = Date.now) {}

  /** Opens a new window and returns when it closes (epoch ms). */
  open(): number {
    this.until = this.now() + LOGIN_WINDOW_MS;
    return this.until;
  }

  isOpen(): boolean {
    return this.now() <= this.until;
  }
}
