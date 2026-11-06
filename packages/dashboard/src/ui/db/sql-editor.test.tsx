/**
 * The editor's text against the `value` its parent passes back. A key can come in after
 * React has rendered the echo of the text before it and before that render's effects
 * run (a busy page, a key right after Enter); the older echo must not replace what was
 * typed (e2e flake: "SELECT *\nFROM" came out as "SELECT *\nROM"). A value the editor
 * didn't send, such as a loaded saved query, still replaces the text.
 */
import { EditorView } from '@codemirror/view';
import { act, render } from '@testing-library/react';
import { useLayoutEffect, useState } from 'react';
import { describe, expect, it } from 'vitest';
import SqlEditor from './SqlEditor.js';

function setup(keyAfterCommit?: { when: string; insert: string }) {
  const editor: { view?: EditorView } = {};
  let parentValue = '';
  let setValue: (v: string) => void = () => undefined;
  let injected = false;
  function Host() {
    const [value, set] = useState('');
    setValue = set;
    parentValue = value;
    // Runs after React commits this value and before the editor's own effects for it:
    // the gap a key typed on a busy page falls into.
    useLayoutEffect(() => {
      if (keyAfterCommit === undefined || injected || value !== keyAfterCommit.when) return;
      injected = true;
      editor.view?.dispatch({
        changes: { from: editor.view.state.doc.length, insert: keyAfterCommit.insert },
        userEvent: 'input.type',
      });
    }, [value]);
    return (
      <SqlEditor
        value={value}
        onChange={set}
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
  const found = EditorView.findFromDOM(content);
  if (found === null) throw new Error('no view');
  editor.view = found;
  const ed = found;
  return {
    text: () => ed.state.doc.toString(),
    parent: () => parentValue,
    type: (text: string) =>
      act(() => {
        ed.dispatch({
          changes: { from: ed.state.doc.length, insert: text },
          userEvent: 'input.type',
        });
      }),
    load: (v: string) => act(() => setValue(v)),
  };
}

describe('SqlEditor value sync', () => {
  it('keeps a key typed between the commit of an older echo and its effects', () => {
    const t = setup({ when: 'SELECT *\n', insert: 'F' });
    t.type('SELECT *\n');
    expect(t.text()).toBe('SELECT *\nF');
    expect(t.parent()).toBe('SELECT *\nF');
    t.type('ROM');
    expect(t.text()).toBe('SELECT *\nFROM');
    expect(t.parent()).toBe('SELECT *\nFROM');
  });

  it('a value the editor did not send replaces the text', () => {
    const t = setup();
    t.type('SELECT 1');
    t.load('SELECT id FROM orders');
    expect(t.text()).toBe('SELECT id FROM orders');
    // Even when it matches text typed earlier.
    t.type(' LIMIT 2');
    t.load('SELECT 1');
    expect(t.text()).toBe('SELECT 1');
  });
});
