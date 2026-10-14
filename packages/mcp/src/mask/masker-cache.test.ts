import { describe, expect, it } from 'vitest';
import { MaskerCache } from './masker-cache.js';

const first = { redact: true, rules: ['jane'] };
const second = { redact: true, rules: ['doe'] };

describe('MaskerCache', () => {
  it('reuses one masker while the settings stay the same', async () => {
    const cache = new MaskerCache();
    const a = await cache.acquire(first);
    const b = await cache.acquire({ redact: true, rules: ['jane'] });
    expect(b.masker).toBe(a.masker);
    a.release();
    b.release();
    await cache.close();
  });

  it('keeps a replaced masker open until the calls using it are done', async () => {
    const cache = new MaskerCache();
    const old = await cache.acquire(first);
    const fresh = await cache.acquire(second);
    expect(fresh.masker).not.toBe(old.masker);
    expect(old.masker.closed).toBe(false);
    // A call that started before the config changed still gets its user rules.
    expect(await old.masker.mask('jane doe')).toEqual({ value: '[masked] doe', notes: [] });
    old.release();
    expect(old.masker.closed).toBe(true);
    expect(fresh.masker.closed).toBe(false);
    fresh.release();
    await cache.close();
    expect(fresh.masker.closed).toBe(true);
  });

  it('closes a masker at once when nothing uses it any more', async () => {
    const cache = new MaskerCache();
    const a = await cache.acquire(first);
    a.release();
    const b = await cache.acquire(second);
    expect(a.masker.closed).toBe(true);
    b.release();
    await cache.close();
  });

  it('closes the current masker on close even while a call holds it', async () => {
    const cache = new MaskerCache();
    const a = await cache.acquire(first);
    await cache.close();
    expect(a.masker.closed).toBe(true);
    a.release();
  });
});
