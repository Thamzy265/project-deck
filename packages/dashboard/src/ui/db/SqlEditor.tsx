/**
 * CodeMirror 6 with the SQLite dialect and the database's tables and columns for
 * autocomplete (UI spec, SQL editor). Cmd/Ctrl+Enter runs, Cmd/Ctrl+S saves, and Tab
 * and Escape leave the editor (no indent on Tab, so no keyboard trap, SC 2.1.2).
 * Loaded on demand: the rest of the dashboard doesn't pay for it.
 *
 * The editor lives in a shadow root. CodeMirror's styles (style-mod) go into a <style>
 * element when mounted in the document, which the daemon's CSP (no 'unsafe-inline')
 * blocks; in a shadow root they go into a constructed style sheet, which it allows.
 */
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { SQLite, sql } from '@codemirror/lang-sql';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, StateEffect, StateField } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import { Decoration, EditorView, keymap, placeholder } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { useEffect, useRef } from 'react';

export interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Table name to its column names, for autocomplete. */
  schema: Record<string, string[]>;
  onRun: () => void;
  onSave: () => void;
  /** Escape: where focus goes when it leaves the editor. */
  onLeave: () => void;
  /** 1-based line SQLite's message points at, marked. */
  errorLine: number | undefined;
  placeholderText: string;
  /** The visible label's text: ids don't cross into the shadow root. */
  label: string;
  /** Help text, given as the editor's description (ids don't cross either). */
  description?: string;
}

const setErrorLine = StateEffect.define<number | undefined>();

const errorLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    let next = marks.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setErrorLine)) continue;
      const n = e.value;
      if (n === undefined || n < 1 || n > tr.state.doc.lines) next = Decoration.none;
      else {
        const line = tr.state.doc.line(n);
        next = Decoration.set([Decoration.line({ class: 'cm-deck-error' }).range(line.from)]);
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Colours from the dashboard's tokens, so both themes keep their contrast. */
const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--deck-accent)', fontWeight: '600' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--deck-diff-added)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--deck-diff-changed)' },
  { tag: tags.comment, color: 'var(--deck-text-muted)', fontStyle: 'italic' },
]);

const theme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--deck-bg)',
    color: 'var(--deck-text)',
    border: '1px solid var(--deck-border)',
    borderRadius: 'var(--deck-radius-sm)',
    minHeight: '6rem',
    maxHeight: '40vh',
  },
  '&.cm-focused': { outline: '2px solid var(--deck-focus)', outlineOffset: '2px' },
  '.cm-scroller': { fontFamily: 'var(--deck-font-mono)', overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--deck-text)', padding: '0.25rem 0' },
  '.cm-placeholder': { color: 'var(--deck-text-muted)' },
  '.cm-deck-error': { backgroundColor: 'var(--deck-diff-removed-tint)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--deck-surface)',
    color: 'var(--deck-text)',
    border: '1px solid var(--deck-border)',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--deck-accent)',
    color: 'var(--deck-bg)',
  },
});

export default function SqlEditor(p: SqlEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const schemaSlot = useRef(new Compartment());
  // The latest callbacks, read by the key bindings made once.
  const latest = useRef(p);
  useEffect(() => {
    latest.current = p;
  });

  useEffect(() => {
    const outer = host.current;
    if (outer === null) return;
    const shadow = outer.shadowRoot ?? outer.attachShadow({ mode: 'open' });
    const parent = document.createElement('div');
    shadow.append(parent);
    const run = () => {
      latest.current.onRun();
      return true;
    };
    const ed = new EditorView({
      parent,
      root: shadow,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          keymap.of([
            { key: 'Mod-Enter', run, preventDefault: true },
            {
              key: 'Mod-s',
              run: () => {
                latest.current.onSave();
                return true;
              },
              preventDefault: true,
            },
          ]),
          history(),
          autocompletion(),
          // Completion keys first, so Escape closes an open list before it leaves.
          keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap]),
          keymap.of([
            {
              key: 'Escape',
              run: () => {
                latest.current.onLeave();
                return true;
              },
            },
          ]),
          schemaSlot.current.of(sql({ dialect: SQLite, schema: latest.current.schema })),
          syntaxHighlighting(highlight),
          placeholder(latest.current.placeholderText),
          errorLineField,
          // Typing over a selection: Chromium's own editing would wrap the new text in a
          // span with a `style` attribute (to keep the replaced token's colour), which
          // the CSP blocks and reports (QA B4-4). Replace the selection here instead.
          EditorView.domEventHandlers({
            beforeinput(event, view) {
              if (event.inputType !== 'insertText' || event.data === null) return false;
              if (view.state.selection.ranges.every((r) => r.empty)) return false;
              event.preventDefault();
              view.dispatch(view.state.replaceSelection(event.data), {
                scrollIntoView: true,
                userEvent: 'input.type',
              });
              return true;
            },
          }),
          theme,
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            'aria-label': latest.current.label,
            ...(latest.current.description === undefined
              ? {}
              : { 'aria-description': latest.current.description }),
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = ed;
    return () => {
      ed.destroy();
      parent.remove();
      view.current = undefined;
    };
  }, []);

  // A saved query loaded from the menu replaces the text.
  const { value, schema, errorLine } = p;
  useEffect(() => {
    const ed = view.current;
    if (ed === undefined || ed.state.doc.toString() === value) return;
    ed.dispatch({ changes: { from: 0, to: ed.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({
      effects: schemaSlot.current.reconfigure(sql({ dialect: SQLite, schema })),
    });
  }, [schema]);

  useEffect(() => {
    view.current?.dispatch({ effects: setErrorLine.of(errorLine) });
  }, [errorLine]);

  return <div ref={host} className="min-w-0" />;
}
