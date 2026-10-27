/**
 * Linear-time checks for tests. They compare the time on a small and a large text, not
 * the time with the clock, so a busy machine doesn't fail them: linear work grows with
 * the size ratio, quadratic work with its square.
 */

/** `unit` repeated and cut to exactly `size` characters. */
export function repeatTo(unit: string, size: number): string {
  return unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
}

/** Milliseconds from the real clock; the helper's own tests pass a fake one. */
const realNow = (): number => performance.now();

/** The time of `calls` calls of `run` on `text`, in milliseconds. */
function timeOf(
  run: (text: string) => unknown,
  text: string,
  calls: number,
  now: () => number,
): number {
  const start = now();
  for (let call = 0; call < calls; call++) run(text);
  return now() - start;
}

export interface Growth {
  small: number;
  large: number;
  /** large / small, with a floor on the small time so timer resolution can't skew it. */
  ratio: number;
}

export interface GrowthOptions {
  /** Calls of `run` per timing, so a fast run is above the timer's resolution. Default 1. */
  calls?: number;
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
 * the text on linear work, plugin tests on ubuntu CI, Oct 2026).
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
  const { calls = 1, rounds = 5, limit, now = realNow } = opts;
  const smallText = repeatTo(unit, smallSize);
  const largeText = repeatTo(unit, largeSize);
  run(smallText);
  run(largeText);
  let small = Number.POSITIVE_INFINITY;
  let large = Number.POSITIVE_INFINITY;
  const ratio = () => large / Math.max(small, 0.5);
  for (let measurement = 0; measurement < MEASUREMENTS; measurement++) {
    for (let round = 0; round < rounds; round++) {
      small = Math.min(small, timeOf(run, smallText, calls, now));
      large = Math.min(large, timeOf(run, largeText, calls, now));
    }
    if (limit === undefined || ratio() < limit) break;
  }
  return { small, large, ratio: ratio() };
}
