/**
 * One Masker (and user-rule worker) per distinct settings. When the config changes, the
 * old Masker is closed once the calls still using it are done, never under them.
 */
import type { MaskSettings } from './masker.js';
import { Masker } from './masker.js';

export interface MaskerLease {
  masker: Masker;
  /** Call once the tool call has finished with the masker. */
  release(): void;
}

interface Entry {
  key: string;
  masker: Masker;
  users: number;
  replaced: boolean;
}

export class MaskerCache {
  private current: Entry | undefined;

  async acquire(settings: MaskSettings): Promise<MaskerLease> {
    const key = JSON.stringify(settings);
    if (this.current?.key !== key) {
      const old = this.current;
      this.current = { key, masker: new Masker(settings), users: 0, replaced: false };
      if (old !== undefined) {
        old.replaced = true;
        if (old.users === 0) void old.masker.close();
      }
    }
    const entry = this.current;
    entry.users++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.users--;
      if (entry.replaced && entry.users === 0) void entry.masker.close();
    };
    // The worker's start-up mustn't eat into the first call's 200 ms budget.
    await entry.masker.ready();
    return { masker: entry.masker, release };
  }

  /** On server shutdown; a call still running gets its user rules skipped. */
  async close(): Promise<void> {
    const entry = this.current;
    this.current = undefined;
    if (entry !== undefined) {
      entry.replaced = true;
      await entry.masker.close();
    }
  }
}
