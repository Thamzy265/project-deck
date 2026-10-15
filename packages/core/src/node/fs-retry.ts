/**
 * Windows refuses to rename over (or remove) a file while another process has it open,
 * with EPERM, EACCES or EBUSY. FlutterDeck's readers hold a file only for a moment, so
 * those operations are tried again for about a second, as graceful-fs does.
 */
import { setTimeout as sleep } from 'node:timers/promises';

const BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** About 1 s in all. */
export const BUSY_RETRY_DELAYS_MS: readonly number[] = [10, 20, 40, 80, 160, 320, 400];

export async function retryWhileBusy<T>(
  operation: () => Promise<T>,
  delays: readonly number[] = BUSY_RETRY_DELAYS_MS,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const delay = delays[attempt];
      if (code === undefined || !BUSY_CODES.has(code) || delay === undefined) throw err;
      await sleep(delay);
    }
  }
}
