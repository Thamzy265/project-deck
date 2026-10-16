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

/** The best of `attempts` times of `run` on `text`, in milliseconds: drops GC pauses. */
export function bestTime(run: (text: string) => unknown, text: string, attempts = 5): number {
  let best = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const start = performance.now();
    run(text);
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

export interface Growth {
  small: number;
  large: number;
  /** large / small, with a floor on the small time so timer resolution can't skew it. */
  ratio: number;
}

/**
 * Times `run` on `unit` repeated to `smallSize` and to `largeSize` characters. Untimed
 * calls on both texts first warm up the code and the regular expressions (V8 compiles a
 * regular expression to native code only after it has run), so neither time includes
 * compiling.
 */
export function growth(
  run: (text: string) => unknown,
  unit: string,
  smallSize: number,
  largeSize: number,
  attempts = 5,
): Growth {
  const smallText = repeatTo(unit, smallSize);
  const largeText = repeatTo(unit, largeSize);
  run(smallText);
  run(largeText);
  const small = bestTime(run, smallText, attempts);
  const large = bestTime(run, largeText, attempts);
  return { small, large, ratio: large / Math.max(small, 0.5) };
}
