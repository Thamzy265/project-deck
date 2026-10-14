/** Placeholder rows while a list loads, so nothing jumps when it arrives. */
export function Skeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-2 p-2">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-4 animate-pulse rounded-sm bg-surface" />
      ))}
    </div>
  );
}
