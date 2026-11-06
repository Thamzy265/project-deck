/**
 * Edge cases for SqlEditor's echo skip (tester probes). The parent here is wired like
 * the real one: onChange sets its state, and a saved query sets it from outside.
 */
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { act, render } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import SqlEditor from './SqlEditor.js';

function setup(opts: { echo?: boolean } = {}) {
  const echo = opts.echo ?? true;
  let setValue: (v: string) => void = () => undefined;
  function Host() {
    const [value, set] = useState('');
    setValue = set;
    return (
      <SqlEditor
        value={value}
        onChange={(v) => {
          if (echo) set(v);
        }}
        schema={{}}
        onRun={() => undefined}
        onSave={() => undefined}
        onLeave={() => undefined}
        errorLine={undefined}
        placeholderText=""
        label="SQL"
      />
    );
  }
  const r = render(<Host />);
  const content =
    r.container.firstElementChild?.shadowRoot?.querySelector<HTMLElement>('.cm-content');
  if (content === null || content === undefined) throw new Error('no editor');
  const view = EditorView.findFromDOM(content);
  if (view === null) throw new Error('no view');
  const text = () => view.state.doc.toString();
  const replaceAll = (insert: string, userEvent = 'input') =>
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert }, userEvent });
  return { view, text, replaceAll, load: (v: string) => act(() => setValue(v)), r };
}

describe('SqlEditor echo skip edge cases', () => {
  // Tester finding F1: a stale entry kept for an echo that never came.
  it('a saved query that equals text typed and deleted inside one React batch still loads', () => {
    const t = setup();
    // Two quick edits that React batches: the committed value stays "" so no effect runs
    // and no echo of "A" ever comes back.
    act(() => {
      t.replaceAll('A');
      t.replaceAll('');
    });
    expect(t.text()).toBe('');
    t.load('A');
    expect(t.text()).toBe('A');
  });

  // Tester finding F1: a stale entry kept for an echo that never came.
  it('a saved query that equals text the parent never echoed still loads', () => {
    const t = setup({ echo: false });
    t.replaceAll('SELECT 1');
    t.replaceAll('SELECT 2');
    t.load('SELECT 1');
    expect(t.text()).toBe('SELECT 1');
  });

  it('clear then retype the same text: the parent reset applies', () => {
    const t = setup();
    act(() => t.replaceAll('SELECT 1'));
    t.load('');
    expect(t.text()).toBe('');
    t.load('SELECT 1');
    expect(t.text()).toBe('SELECT 1');
  });

  it('undo after a loaded saved query: the parent follows, and loading the saved text again applies', () => {
    const t = setup();
    act(() => t.replaceAll('typed', 'input.type'));
    t.load('saved');
    expect(t.text()).toBe('saved');
    act(() => {
      undo(t.view);
    });
    // Undo may merge the typed text and the load into one step: only "saved" must be gone.
    expect(t.text()).not.toBe('saved');
    // The parent's value followed the undo, so loading "saved" again replaces the text.
    t.load('saved');
    expect(t.text()).toBe('saved');
  });

  it('a paste then a parent reset to another text, then back to the pasted text', () => {
    const t = setup();
    act(() => t.replaceAll('SELECT * FROM big', 'input.paste'));
    t.load('SELECT 2');
    expect(t.text()).toBe('SELECT 2');
    t.load('SELECT * FROM big');
    expect(t.text()).toBe('SELECT * FROM big');
  });

  it('a remounted editor starts from the parent value and takes later loads', () => {
    const t = setup();
    act(() => t.replaceAll('before'));
    t.r.unmount();
    const t2 = setup();
    t2.load('after');
    expect(t2.text()).toBe('after');
  });
});
