import type { TableInfo } from '@project-deck/core';
import type { KeyboardEvent, PointerEvent } from 'react';
import { useMemo, useRef, useState } from 'react';
import { BOX_HEADER, BOX_ROW, boxLabel, layoutDiagram } from '../../db/diagram-layout.js';
import { visibleText } from '../../db/cells.js';
import { button } from '../styles.js';
import { VisibleText } from './VisibleText.js';

const ZOOM_STEP = 1.25;
const PAN_STEP = 80;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;

/**
 * Tables as boxes with their columns and foreign-key lines (UI spec, schema diagram).
 * Zoom and pan have buttons as well as dragging and arrow keys (SC 2.5.7), and the
 * list view says the same in text: it is the default at 320 px and the screen-reader
 * alternative at all sizes.
 */
export function SchemaDiagram({
  tables,
  onOpen,
  listByDefault,
}: {
  tables: TableInfo[];
  onOpen: (table: string) => void;
  listByDefault: boolean;
}) {
  const [list, setList] = useState(listByDefault);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | undefined>(undefined);
  const layout = useMemo(() => layoutDiagram(tables), [tables]);
  const byName = useMemo(() => new Map(tables.map((t) => [t.name, t])), [tables]);

  if (tables.length === 0) return <p className="p-2">No tables</p>;

  const zoomBy = (factor: number) =>
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor)));
  const panBy = (dx: number, dy: number) => setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
  const fit = () => {
    const el = canvas.current;
    const w = el?.clientWidth ?? layout.width;
    const h = el?.clientHeight ?? layout.height;
    setZoom(Math.min(1, Math.max(MIN_ZOOM, Math.min(w / layout.width, h / layout.height))));
    setPan({ x: 0, y: 0 });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    const moves: Record<string, [number, number]> = {
      ArrowUp: [0, PAN_STEP],
      ArrowDown: [0, -PAN_STEP],
      ArrowLeft: [PAN_STEP, 0],
      ArrowRight: [-PAN_STEP, 0],
    };
    const m = moves[e.key];
    if (m === undefined) return;
    e.preventDefault();
    panBy(m[0], m[1]);
  };
  const onPointerDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('button') !== null) return;
    drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (d === undefined) return;
    setPan({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y });
  };

  const tools = (
    <div className="flex flex-wrap items-center gap-1 p-2" role="toolbar" aria-label="Diagram">
      <button type="button" className={button} aria-pressed={list} onClick={() => setList(!list)}>
        List view
      </button>
      {!list && (
        <>
          <button
            type="button"
            className={button}
            aria-label="Zoom in"
            onClick={() => zoomBy(ZOOM_STEP)}
          >
            +
          </button>
          <button
            type="button"
            className={button}
            aria-label="Zoom out"
            onClick={() => zoomBy(1 / ZOOM_STEP)}
          >
            −
          </button>
          <button type="button" className={button} onClick={fit}>
            Fit
          </button>
          <button
            type="button"
            className={button}
            aria-label="Pan up"
            onClick={() => panBy(0, PAN_STEP)}
          >
            ↑
          </button>
          <button
            type="button"
            className={button}
            aria-label="Pan down"
            onClick={() => panBy(0, -PAN_STEP)}
          >
            ↓
          </button>
          <button
            type="button"
            className={button}
            aria-label="Pan left"
            onClick={() => panBy(PAN_STEP, 0)}
          >
            ←
          </button>
          <button
            type="button"
            className={button}
            aria-label="Pan right"
            onClick={() => panBy(-PAN_STEP, 0)}
          >
            →
          </button>
        </>
      )}
    </div>
  );

  if (list) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {tools}
        <ul aria-label="Tables and links" className="min-h-0 flex-1 overflow-auto px-2">
          {tables.map((t) => (
            <li key={t.name} className="border-b border-border/30 py-1">
              <button
                type="button"
                className="text-left font-medium text-accent underline"
                onClick={() => onOpen(t.name)}
              >
                <VisibleText text={t.name} />
              </button>
              {t.kind === 'view' && <span className="text-sm text-muted"> view</span>}
              <p className="font-mono text-sm wrap-anywhere">
                <VisibleText text={t.columns.map((c) => c.name).join(', ')} />
              </p>
              {t.foreignKeys.map((fk, i) => (
                <p key={i} className="text-sm text-muted">
                  <VisibleText
                    text={`${fk.from} → ${fk.table}${fk.to === null ? '' : `.${fk.to}`}`}
                  />
                </p>
              ))}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {tools}
      <div
        ref={canvas}
        role="group"
        aria-label="Schema diagram. Arrow keys pan."
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = undefined)}
        onPointerCancel={() => (drag.current = undefined)}
        className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden bg-surface"
      >
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          }}
        >
          <svg
            aria-hidden="true"
            width={layout.width}
            height={layout.height}
            className="absolute top-0 left-0 text-muted"
          >
            {layout.links.map((l, i) => (
              <path
                key={i}
                d={`M ${l.x1} ${l.y1} C ${(l.x1 + l.x2) / 2} ${l.y1}, ${(l.x1 + l.x2) / 2} ${l.y2}, ${l.x2} ${l.y2}`}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
              />
            ))}
          </svg>
          {layout.boxes.map((b) => {
            const t = byName.get(b.name);
            if (t === undefined) return null;
            return (
              <button
                key={b.name}
                type="button"
                aria-label={visibleText(boxLabel(t))}
                onClick={() => onOpen(t.name)}
                className="absolute flex flex-col overflow-hidden rounded-md border border-border bg-bg text-left hover:bg-surface"
                style={{ left: b.x, top: b.y, width: b.width, height: b.height }}
              >
                <span
                  className="flex shrink-0 items-center truncate border-b border-border px-2 font-medium"
                  style={{ height: BOX_HEADER }}
                >
                  <VisibleText text={t.name} />
                </span>
                {t.columns.map((c) => (
                  <span
                    key={c.name}
                    className="flex shrink-0 items-center gap-1 truncate px-2 font-mono text-sm"
                    style={{ height: BOX_ROW }}
                  >
                    <VisibleText text={c.name} />
                    {c.pk && <span className="text-muted">PK</span>}
                    {t.foreignKeys.some((f) => f.from === c.name) && (
                      <span className="text-muted">FK</span>
                    )}
                  </span>
                ))}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
