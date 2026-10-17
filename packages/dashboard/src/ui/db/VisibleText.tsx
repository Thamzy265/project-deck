import { visibleSegments } from '../../db/cells.js';

/**
 * Untrusted text as text nodes, with bidi, zero-width and control characters shown as
 * small named marks instead of acting (design note, abuse cases). `isolate` keeps any
 * right-to-left text from reordering what is around it.
 */
export function VisibleText({ text, multiline = false }: { text: string; multiline?: boolean }) {
  return (
    <bdi>
      {visibleSegments(text, { multiline }).map((s, i) =>
        'mark' in s ? (
          <span
            key={i}
            className="mx-px rounded-sm border border-border px-0.5 font-mono text-sm text-muted"
          >
            {s.mark}
          </span>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </bdi>
  );
}
