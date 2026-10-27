/**
 * The growth helper itself, on a fake clock: each simulated run moves the clock by a
 * known cost, so no real time passes and every ratio is exact, however busy the machine.
 */
import { describe, expect, it } from 'vitest';
import { growth } from './timing.js';

const SMALL = 1_000;
const LARGE = 8_000;
/** The callers' threshold for 8 times the text: linear is about 8, quadratic about 64. */
const THRESHOLD = 24;
/** Extra milliseconds a stalled call takes. */
const STALL = 50;

/** 1 ms per 1,000 characters: 1 ms small, 8 ms large. */
const linear = (n: number): number => n / 1_000;
/** 0.5 ms small, 32 ms large. */
const quadratic = (n: number): number => (n / 1_000) ** 2 / 2;

/**
 * A fake clock and a run that moves it by `cost` of the text's length, plus STALL on the
 * calls `stalled` picks. Calls are numbered from 0: with the defaults, 0 and 1 warm up,
 * then each round times one small call and one large call (2 and 3, 4 and 5, ...).
 */
function simulate(cost: (n: number) => number, stalled: (call: number, at: number) => boolean) {
  let clock = 0;
  let calls = 0;
  const run = (text: string) => {
    if (stalled(calls, clock)) clock += STALL;
    clock += cost(text.length);
    calls++;
  };
  return { run, now: () => clock, calls: () => calls };
}

const never = () => false;

describe('growth', () => {
  it('passes linear work when one stall covers several calls in a row', () => {
    // Like the CI stall on 26 Oct 2026 (1 ms -> 58 ms on linear work): calls 7 to 11
    // each take 50 ms longer, which covers every timed large call of a helper that
    // times all the small calls first and then all the large ones.
    const sim = simulate(linear, (call) => call >= 7 && call <= 11);
    expect(growth(sim.run, 'a', SMALL, LARGE, { now: sim.now }).ratio).toBe(8);
  });

  it('still fails quadratic work', () => {
    const sim = simulate(quadratic, never);
    expect(growth(sim.run, 'a', SMALL, LARGE, { now: sim.now }).ratio).toBe(64);
  });

  it('still fails quadratic work when a stall hits a small run', () => {
    // Keeping the round with the lowest ratio would pick round 0 (32 / 50.5) and pass it.
    const sim = simulate(quadratic, (call) => call === 2);
    expect(growth(sim.run, 'a', SMALL, LARGE, { now: sim.now }).ratio).toBe(64);
  });
});

describe('growth under a long stall (tester probes, 27 Oct 2026)', () => {
  /** Calls 0 and 1 are the warm-up, call 2 is the first timed small run. */
  const FIRST_STALLED_CALL = 3;
  /** 2 warm-up calls and 5 rounds of one small and one large call. */
  const LAST_CALL_OF_FIRST_MEASUREMENT = 11;
  const restOfFirstMeasurement = (call: number) =>
    call >= FIRST_STALLED_CALL && call <= LAST_CALL_OF_FIRST_MEASUREMENT;

  it('stalls that only slow a window of calls leave the best times clean', () => {
    // A 300 ms stall from call 3 on slows calls 3 to 8 (call 8 starts at 286 ms, inside
    // it): rounds 0 and 4 have clean small runs, and rounds 3 and 4 clean large ones.
    let stallEnd = Number.POSITIVE_INFINITY;
    const sim = simulate(linear, (call, at) => {
      if (call === FIRST_STALLED_CALL) stallEnd = at + 300;
      return call >= FIRST_STALLED_CALL && at < stallEnd;
    });
    expect(growth(sim.run, 'a', SMALL, LARGE, { now: sim.now }).ratio).toBe(8);
  });

  it('passes linear work when a stall covers every call after the first small run', () => {
    // Only the first small run of the measurement is clean, so the first measurement is
    // 58 / 1. The stall ends with it, so a second measurement is clean and counts.
    const sim = simulate(linear, restOfFirstMeasurement);
    expect(growth(sim.run, 'a', SMALL, LARGE, { now: sim.now, limit: THRESHOLD }).ratio).toBe(8);
    // Warm-up and two measurements of 10 calls: it stopped once a ratio was under the limit.
    expect(sim.calls()).toBe(22);
  });

  it('still fails quadratic work under the same long stall', () => {
    // 82 / 0.5 the first time, 32 / 0.5 the second and the third.
    const sim = simulate(quadratic, restOfFirstMeasurement);
    expect(growth(sim.run, 'a', SMALL, LARGE, { now: sim.now, limit: THRESHOLD }).ratio).toBe(64);
    expect(sim.calls()).toBe(32);
  });

  it('still fails quadratic work when a stall covers every small run of a later measurement', () => {
    // The second measurement's small runs (calls 12 to 20, even) take 50 ms longer: on
    // its own it is 32 / 50.5. The best small and large times over all measurements count.
    const sim = simulate(quadratic, (call) => call >= 12 && call <= 20 && call % 2 === 0);
    expect(growth(sim.run, 'a', SMALL, LARGE, { now: sim.now, limit: THRESHOLD }).ratio).toBe(64);
  });

  it('reports linear work over the limit when a stall outlasts every measurement', () => {
    // The limit of the retry: a stall on every later call looks like slow work.
    const sim = simulate(linear, (call) => call >= FIRST_STALLED_CALL);
    expect(growth(sim.run, 'a', SMALL, LARGE, { now: sim.now, limit: THRESHOLD }).ratio).toBe(58);
  });
});
