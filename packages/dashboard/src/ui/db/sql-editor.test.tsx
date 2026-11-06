/**
 * The editor's text against the `value` its parent passes back. React can render an
 * older echo of the text after the user has typed more (a busy page, a key right after
 * Enter); that echo must not replace what was typed (e2e flake: "SELECT *\nFROM" came out
 * as "SELECT *\nROM"). A value the editor never sent, such as a loaded saved query, still
 * replaces the text.
 */
import { EditorView } from '@codemirror/view';
import { act, render } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import SqlEditor from './SqlEditor.js';

function setup() {
  const sent: string[] = [];
  let setValue: (v: string) => void = () => undefined;
  function Host() {
    const [value, set] = useState('');
    setValue = set;
    return (
      <SqlEditor
        value={value}
        onChange={(v) => sent.push(v)}
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
  const { container } = render(<Host />);
  const content =
    container.firstElementChild?.shadowRoot?.querySelector<HTMLElement>('.cm-content');
  if (content === null || content === undefined) throw new Error('no editor');
  const view = EditorView.findFromDOM(content);
  if (view === null) throw new Error('no view');
  const type = (text: string) =>
    view.dispatch({ changes: { from: view.state.doc.length, insert: text }, userEvent: 'input' });
  const parentRenders = (v: string) => act(() => setValue(v));
  return { view, sent, type, parentRenders };
}

describe('SqlEditor value sync', () => {
  it('keeps text typed after the change React is still rendering', () => {
    const t = setup();
    t.type('SELECT *\n');
    t.type('F');
    expect(t.sent).toEqual(['SELECT *\n', 'SELECT *\nF']);
    // React commits the first echo only now, after "F" went in.
    t.parentRenders('SELECT *\n');
    expect(t.view.state.doc.toString()).toBe('SELECT *\nF');
    t.parentRenders('SELECT *\nF');
    expect(t.view.state.doc.toString()).toBe('SELECT *\nF');
    t.type('ROM');
    t.parentRenders('SELECT *\nFROM');
    expect(t.view.state.doc.toString()).toBe('SELECT *\nFROM');
  });

  it('a value the editor did not send replaces the text', () => {
    const t = setup();
    t.type('SELECT 1');
    t.parentRenders('SELECT 1');
    t.parentRenders('SELECT id FROM orders');
    expect(t.view.state.doc.toString()).toBe('SELECT id FROM orders');
    // Even when it matches text typed earlier.
    t.type(' LIMIT 2');
    t.parentRenders('SELECT id FROM orders LIMIT 2');
    t.parentRenders('SELECT 1');
    expect(t.view.state.doc.toString()).toBe('SELECT 1');
  });
});
