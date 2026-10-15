/** Where a command writes: `out` for its result, `err` for problems. One line per call. */
export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
