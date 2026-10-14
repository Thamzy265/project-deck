import { describe, expect, it } from 'vitest';
import { createSessionGuard, readShortcutsEnabled, writeShortcutsEnabled } from './storage.js';

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

const broken = (): Storage => {
  throw new DOMException('denied', 'SecurityError');
};

describe('session guard (one reload per lost login)', () => {
  it('allows one reload, then refuses until cleared', () => {
    const storage = new MemoryStorage();
    const guard = createSessionGuard(() => storage);
    expect(guard.tryReload()).toBe(true);
    expect(guard.tryReload()).toBe(false);
    guard.clear();
    expect(guard.tryReload()).toBe(true);
  });

  it('survives a page reload because the flag is in storage', () => {
    const storage = new MemoryStorage();
    expect(createSessionGuard(() => storage).tryReload()).toBe(true);
    expect(createSessionGuard(() => storage).tryReload()).toBe(false);
  });

  it('never reloads when storage is unavailable, so it cannot loop', () => {
    const guard = createSessionGuard(broken);
    expect(guard.tryReload()).toBe(false);
    expect(() => guard.clear()).not.toThrow();
  });
});

describe('keyboard shortcuts switch', () => {
  it('is on by default and remembers off', () => {
    const storage = new MemoryStorage();
    expect(readShortcutsEnabled(() => storage)).toBe(true);
    writeShortcutsEnabled(() => storage, false);
    expect(readShortcutsEnabled(() => storage)).toBe(false);
    writeShortcutsEnabled(() => storage, true);
    expect(readShortcutsEnabled(() => storage)).toBe(true);
  });

  it('falls back to on when storage throws', () => {
    expect(readShortcutsEnabled(broken)).toBe(true);
    expect(() => writeShortcutsEnabled(broken, false)).not.toThrow();
  });
});
