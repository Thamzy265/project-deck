/**
 * Browser storage can be missing or throw (private windows, blocked site data), so every
 * access is wrapped and falls back to a safe default.
 */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type StorageSource = () => StorageLike;

const RELOAD_FLAG = 'flutterdeck.reloadedForLogin';
const SHORTCUTS_KEY = 'flutterdeck.shortcuts';

export interface SessionGuard {
  /** True (and remembered) the first time; false until `clear()`, even across reloads. */
  tryReload(): boolean;
  /** Called after the first authenticated success, so the next daemon restart recovers too. */
  clear(): void;
}

export function createSessionGuard(storage: StorageSource): SessionGuard {
  return {
    tryReload() {
      try {
        const s = storage();
        if (s.getItem(RELOAD_FLAG) !== null) return false;
        s.setItem(RELOAD_FLAG, '1');
        return true;
      } catch {
        // Without the flag a reload could repeat forever.
        return false;
      }
    },
    clear() {
      try {
        storage().removeItem(RELOAD_FLAG);
      } catch {
        // Nothing stored, nothing to clear.
      }
    },
  };
}

export function readShortcutsEnabled(storage: StorageSource): boolean {
  try {
    return storage().getItem(SHORTCUTS_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function writeShortcutsEnabled(storage: StorageSource, enabled: boolean): void {
  try {
    storage().setItem(SHORTCUTS_KEY, enabled ? 'on' : 'off');
  } catch {
    // The switch still works for this page; it just isn't remembered.
  }
}
