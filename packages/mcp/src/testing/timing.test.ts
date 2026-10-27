/**
 * The growth helper itself, on simulated work: busy-waits that take a known time per
 * character, so the results don't depend on how fast the machine is.
 */
import { describe, expect, it } from 'vitest';
import { growth } from './timing.js';

/** Keeps the thread busy for `ms`: a timer would let a stall elsewhere go unseen. */
function busy(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // Spin.
  }
}

const SMALL = 1_000;
const LARGE = 8_000;
/** The callers' threshold for 8 times the text: linear is about 8, quadratic about 64. */
const THRESHOLD = 24;

/** 1 ms per 1,000 characters. */
function linear(text: string): void {
  busy(text.length / 1_000);
}

/** 0.5 ms at 1,000 characters, 32 ms at 8,000. */
function quadratic(text: string): void {
  busy((text.length / 1_000) ** 2 / 2);
}

describe('growth', () => {
  it('passes linear work when one stall covers several calls in a row', () => {
    // Like the plugin's CI stall, 26 Oct 2026 (1 ms -> 58 ms on linear work): calls 4 to 6
    // each take 50 ms longer, which covers every timed large call of a helper that
    // times all the small calls first and then all the large ones.
    let call = 0;
    const stalled = (text: string) => {
      if (call >= 4 && call <= 6) busy(50);
      call++;
      linear(text);
    };
    expect(growth(stalled, 'a', SMALL, LARGE).ratio).toBeLessThan(THRESHOLD);
  });

  it('still fails quadratic work', () => {
    expect(growth(quadratic, 'a', SMALL, LARGE).ratio).toBeGreaterThan(THRESHOLD);
  });

  it('still fails quadratic work when a stall hits a small run', () => {
    // The first timed small call takes 50 ms longer. Keeping the round with the lowest
    // ratio would pick that round (about 32 / 50) and pass the quadratic work.
    let call = 0;
    const stalled = (text: string) => {
      if (call === 2) busy(50);
      call++;
      quadratic(text);
    };
    expect(growth(stalled, 'a', SMALL, LARGE).ratio).toBeGreaterThan(THRESHOLD);
  });
});
