import { afterEach, describe, expect, it } from 'vitest';
import { CUT_MARKER, MASKING_OFF, MAX_TEXT, Masker, RULES_SKIPPED } from './masker.js';

const maskers: Masker[] = [];
function masker(redact: boolean, rules: string[] = []): Masker {
  const m = new Masker({ redact, rules });
  maskers.push(m);
  return m;
}

afterEach(async () => {
  await Promise.all(maskers.splice(0).map((m) => m.close()));
});

describe('Masker', () => {
  it('masks every string in a nested value and keeps its shape', async () => {
    const m = masker(true, ['Alice']);
    const value = {
      app: { name: 'shop', device: { name: 'Alice phone' } },
      entries: [
        { ts: 1, message: 'mail jane@example.com', tag: 'auth' },
        { ts: 2, message: 'ok', stack: 'Bearer abcdefgh12345678' },
      ],
      count: 2,
      flag: true,
      none: null,
    };
    const { value: out, notes } = await m.mask(value);
    expect(out).toEqual({
      app: { name: 'shop', device: { name: '[masked] phone' } },
      entries: [
        { ts: 1, message: 'mail [email masked]', tag: 'auth' },
        { ts: 2, message: 'ok', stack: 'Bearer [token masked]' },
      ],
      count: 2,
      flag: true,
      none: null,
    });
    expect(notes).toEqual([]);
  });

  it('cuts each text to 4 kB after the built-ins, so a value across the cut is masked', async () => {
    const m = masker(true);
    const long = `${'x'.repeat(MAX_TEXT - 5)} jane@example.com`;
    const { value } = await m.mask({ message: long });
    expect(value.message).toBe(`${'x'.repeat(MAX_TEXT - 5)} ${CUT_MARKER}`);
  });

  it('masks before the cut, and never leaves half a marker', async () => {
    const m = masker(true);
    const { value } = await m.mask({ message: `${'z'.repeat(MAX_TEXT - 6)} jane@example.com` });
    expect(value.message).toBe(`${'z'.repeat(MAX_TEXT - 6)} ${CUT_MARKER}`);
  });

  it('masks a huge line quickly, looking at its first 64 kB', async () => {
    const m = masker(true);
    const start = performance.now();
    const { value } = await m.mask({ message: `jane@example.com ${'ab1 '.repeat(250_000)}` });
    expect(performance.now() - start).toBeLessThan(500);
    expect(value.message.startsWith('[email masked] ab1')).toBe(true);
    expect(value.message.endsWith(CUT_MARKER)).toBe(true);
  });

  it('runs user rules before the cut, so a value across it is masked whole', async () => {
    const m = masker(true, ['order-\\d+']);
    const text = `${'x'.repeat(MAX_TEXT - 6)} order-123456 tail`;
    const { value } = await m.mask({ message: text });
    expect(value.message).not.toContain('order');
    expect(value.message).toBe(`${'x'.repeat(MAX_TEXT - 6)} ${CUT_MARKER}`);
  });

  it('says so when masking is off, and changes nothing but the length', async () => {
    const m = masker(false, ['jane']);
    const { value, notes } = await m.mask({ message: 'jane@example.com' });
    expect(value.message).toBe('jane@example.com');
    expect(notes).toEqual([MASKING_OFF]);
    expect(MASKING_OFF).toBe('Masking for Claude is off');
  });

  it('keeps the built-ins and notes skipped rules when a user rule is too slow', async () => {
    const m = masker(true, ['(a|a)*b']);
    await m.ready();
    const start = performance.now();
    const { value, notes } = await m.mask({ message: `jane@example.com ${'a'.repeat(4096)}` });
    expect(performance.now() - start).toBeLessThan(450);
    expect(value.message.startsWith('[email masked] aaa')).toBe(true);
    expect(value.message.endsWith(CUT_MARKER)).toBe(true);
    expect(notes).toEqual([RULES_SKIPPED]);
    expect(RULES_SKIPPED).toBe('Some masking rules were skipped (too slow)');
  });
});
