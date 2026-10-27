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

describe('growth under a long stall (tester probes, 27 Oct 2026)', () => {
  /** Calls 0 and 1 are the warm-up, call 2 is the first timed small run. */
  const FIRST_STALLED_CALL = 3;
  /** 2 warm-up calls and 5 rounds of one small and one large call. */
  const LAST_CALL_OF_FIRST_MEASUREMENT = 11;

  it('stalls that only slow a window of calls leave the best times clean', () => {
    // Regression lock: a wall-clock stall of about 300 ms where each call in it takes
    // 50 ms longer covers about 5 calls; the later rounds are clean again.
    let call = 0;
    let stallEnd = 0;
    const stalled = (text: string) => {
      if (call === FIRST_STALLED_CALL) stallEnd = performance.now() + 300;
      if (call >= FIRST_STALLED_CALL && performance.now() < stallEnd) busy(50);
      call++;
      linear(text);
    };
    expect(growth(stalled, 'a', SMALL, LARGE).ratio).toBeLessThan(THRESHOLD);
  });

  // Only the first small run of the measurement is clean, so best small is 1 ms and every
  // large run is stalled (about 58 ms): ratio about 58 > 24 on linear work. The stall ends
  // with the measurement (about 450 ms), so a second measurement is clean.
  it('passes linear work when a stall covers every call after the first small run', () => {
    let call = 0;
    const stalled = (text: string) => {
      if (call >= FIRST_STALLED_CALL && call <= LAST_CALL_OF_FIRST_MEASUREMENT) busy(50);
      call++;
      linear(text);
    };
    expect(growth(stalled, 'a', SMALL, LARGE, { limit: THRESHOLD }).ratio).toBeLessThan(THRESHOLD);
  });

  it('still fails quadratic work under the same long stall', () => {
    let call = 0;
    const stalled = (text: string) => {
      if (call >= FIRST_STALLED_CALL && call <= LAST_CALL_OF_FIRST_MEASUREMENT) busy(50);
      call++;
      quadratic(text);
    };
    expect(growth(stalled, 'a', SMALL, LARGE, { limit: THRESHOLD }).ratio).toBeGreaterThan(
      THRESHOLD,
    );
  });
});
