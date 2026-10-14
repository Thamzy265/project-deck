/** Decorative; the text next to it says what is happening. Static when motion is reduced. */
export function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-3 animate-spin rounded-full border-2 border-border border-t-accent"
    />
  );
}
