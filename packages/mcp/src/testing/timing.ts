/**
 * Linear-time checks for tests. They compare the time on a small and a large text, not
 * the time with the clock, so a busy machine doesn't fail them: linear work grows with
 * the size ratio, quadratic work with its square.
 */

/** `unit` repeated and cut to exactly `size` characters. */
export function repeatTo(unit: string, size: number): string {
  return unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
}

/**
 * The best of three times of `calls` calls of `run` on `text`, in milliseconds. The best
 * of three drops pauses from garbage collection or other processes.
 */
export function bestTime(run: (text: string) => unknown, text: string, calls = 1): number {
  let best = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 3; attempt++) {
    const start = performance.now();
    for (let call = 0; call < calls; call++) run(text);
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
 * Times `run` on `unit` repeated to `smallSize` and to `largeSize` characters. One
 * untimed call first warms up the code, so the small time isn't inflated by compiling.
 */
export function growth(
  run: (text: string) => unknown,
  unit: string,
  smallSize: number,
  largeSize: number,
  calls = 1,
): Growth {
  const smallText = repeatTo(unit, smallSize);
  const largeText = repeatTo(unit, largeSize);
  run(smallText);
  const small = bestTime(run, smallText, calls);
  const large = bestTime(run, largeText, calls);
  return { small, large, ratio: large / Math.max(small, 0.5) };
}
