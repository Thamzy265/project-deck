/**
 * Linear-time checks for the plugin tests, in the style of packages/mcp/src/testing/timing.ts
 * (a copy: the plugin depends on nothing but core). They compare the time on a small and a
 * large text, not the time with the clock: linear work grows with the size ratio,
 * quadratic work with its square.
 */

/** `unit` repeated and cut to exactly `size` characters. */
export function repeatTo(unit: string, size: number): string {
  return unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
}

/** Milliseconds from the real clock; the helper's own tests pass a fake one. */
const realNow = (): number => performance.now();

/** The best of `attempts` times of `run` on `text`, in milliseconds: drops GC pauses. */
export function bestTime(
  run: (text: string) => unknown,
  text: string,
  attempts = 5,
  now: () => number = realNow,
): number {
  let best = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const start = now();
    run(text);
    best = Math.min(best, now() - start);
  }
  return best;
}

export interface Growth {
  small: number;
  large: number;
  /** large / small, with a floor on the small time so timer resolution can't skew it. */
  ratio: number;
}

export interface GrowthOptions {
  /** Times per round for each text, best of them counts. Default 1. */
  attempts?: number;
  /** Rounds of one small and one large timing per measurement. Default 5. */
  rounds?: number;
  /** The ratio the caller fails on. Without it, one measurement is taken. */
  limit?: number;
  /** The clock, in milliseconds. Default performance.now; the helper's tests fake it. */
  now?: () => number;
}

/** Measurements at most, when each one is at or over the limit. */
const MEASUREMENTS = 3;

/**
 * Times `run` on `unit` repeated to `smallSize` and to `largeSize` characters. Untimed
 * calls on both texts first warm up the code and the regular expressions (V8 compiles a
 * regular expression to native code only after it has run), so neither time includes
 * compiling.
 *
 * The small and the large text are timed back to back in each of `rounds` rounds, and the
 * best small time and the best large time over all rounds count. A stall only makes a
 * time longer, so each best comes from a round it missed. Timing all the small runs
 * first and then all the large ones let one stall inflate every large time (56x for 8x
 * the text on linear work, ubuntu CI, Oct 2026).
 *
 * With a `limit`, a ratio at or over it is measured again, up to MEASUREMENTS times in
 * all, and the best small and large times over all of them count. Linear work then passes
 * when a stall spoils one whole measurement, but work that really grows faster than the
 * text stays over the limit. Not the lowest ratio of the measurements: one whose small
 * runs all stalled has a low ratio even for quadratic work.
 */
export function growth(
  run: (text: string) => unknown,
  unit: string,
  smallSize: number,
  largeSize: number,
  opts: GrowthOptions = {},
): Growth {
  const { attempts = 1, rounds = 5, limit, now = realNow } = opts;
  const smallText = repeatTo(unit, smallSize);
  const largeText = repeatTo(unit, largeSize);
  run(smallText);
  run(largeText);
  let small = Number.POSITIVE_INFINITY;
  let large = Number.POSITIVE_INFINITY;
  const ratio = () => large / Math.max(small, 0.5);
  for (let measurement = 0; measurement < MEASUREMENTS; measurement++) {
    for (let round = 0; round < rounds; round++) {
      small = Math.min(small, bestTime(run, smallText, attempts, now));
      large = Math.min(large, bestTime(run, largeText, attempts, now));
    }
    if (limit === undefined || ratio() < limit) break;
  }
  return { small, large, ratio: ratio() };
}
