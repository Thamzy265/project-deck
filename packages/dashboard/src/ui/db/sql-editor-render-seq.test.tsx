/**
 * Probes of SqlEditor's render-number echo detection (tester): StrictMode double
 * effects, a parent that transforms the value, an onChange that throws, a parent that
 * sets its value in a transition, rapid saved-query loads, and a remount mid-typing.
 */
import { EditorView } from '@codemirror/view';
import { act, render } from '@testing-library/react';
import { StrictMode, startTransition, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SqlEditor from './SqlEditor.js';

interface Opts {
  initial?: string;
  strict?: boolean;
  /** What the parent stores for a text the editor sent. */
  store?: (v: string) => string;
  transition?: boolean;
  throwOn?: string;
}

function setup(o: Opts = {}) {
  let setValue: (v: string) => void = () => undefined;
  const calls: string[] = [];
  function Host() {
    const [value, set] = useState(o.initial ?? '');
    setValue = set;
    return (
      <SqlEditor
        value={value}
        onChange={(v) => {
          calls.push(v);
          if (v === o.throwOn) throw new Error('parent rejected');
          const next = (o.store ?? ((x: string) => x))(v);
          if (o.transition === true) startTransition(() => set(next));
          else set(next);
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
  const ui =
    o.strict === true ? (
      <StrictMode>
        <Host />
      </StrictMode>
    ) : (
      <Host />
    );
  const r = render(ui);
  const content =
    r.container.firstElementChild?.shadowRoot?.querySelector<HTMLElement>('.cm-content');
  if (content === null || content === undefined) throw new Error('no editor');
  const view = EditorView.findFromDOM(content);
  if (view === null) throw new Error('no view');
  return {
    r,
    calls,
    text: () => view.state.doc.toString(),
    type: (insert: string) =>
      act(() => {
        view.dispatch({
          changes: { from: view.state.doc.length, insert },
          userEvent: 'input.type',
        });
      }),
    load: (v: string) => act(() => setValue(v)),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('SqlEditor render-number echo detection', () => {
  it('StrictMode: starts from the value, keeps typing, and takes a saved query', () => {
    const t = setup({ strict: true, initial: 'SELECT 1' });
    expect(t.text()).toBe('SELECT 1');
    t.type(' + 1');
    expect(t.text()).toBe('SELECT 1 + 1');
    t.load('SELECT 2');
    expect(t.text()).toBe('SELECT 2');
    t.type('0');
    expect(t.text()).toBe('SELECT 20');
  });

  it('a parent that trims: the trimmed value replaces the text and typing goes on', () => {
    const t = setup({ store: (v) => v.trimEnd() });
    t.type('SELECT 1 ');
    expect(t.text()).toBe('SELECT 1');
    t.type('+ 2');
    expect(t.text()).toBe('SELECT 1+ 2');
    // Settles: no onChange storm from the replacement.
    expect(t.calls.length).toBeLessThan(10);
  });

  it('a parent that upper-cases: the editor shows the parent text', () => {
    const t = setup({ store: (v) => v.toUpperCase() });
    t.type('select');
    expect(t.text()).toBe('SELECT');
  });

  it('an onChange that throws does not stop later saved queries or typing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const t = setup({ throwOn: 'A' });
    t.type('A');
    expect(t.text()).toBe('A');
    t.load('A');
    expect(t.text()).toBe('A');
    t.load('B');
    expect(t.text()).toBe('B');
    t.type('C');
    expect(t.text()).toBe('BC');
  });

  // act() flushes each transition at once, so this checks the settled text only. It
  // doesn't make the lane race a real transition could (SqlEditorProps rules it out).
  it('a parent that sets its value in a transition: the settled text keeps every key', () => {
    const t = setup({ transition: true });
    t.type('SELECT *\n');
    t.type('F');
    t.type('ROM');
    expect(t.text()).toBe('SELECT *\nFROM');
    t.load('SELECT 1');
    expect(t.text()).toBe('SELECT 1');
  });

  it('rapid saved-query loads end on the last one, one by one and batched', () => {
    const t = setup();
    for (const q of ['A', 'B', 'A', 'C', 'A']) {
      t.load(q);
      expect(t.text()).toBe(q);
    }
    act(() => {
      t.load('X');
      t.load('Y');
      t.load('Z');
    });
    expect(t.text()).toBe('Z');
    t.load('X');
    expect(t.text()).toBe('X');
  });

  it('a saved query equal to the text just typed, after other loads, still applies', () => {
    const t = setup();
    t.type('SELECT 1');
    t.load('OTHER');
    t.type('!');
    t.load('SELECT 1');
    expect(t.text()).toBe('SELECT 1');
  });

  it('remount mid-typing: the new editor takes the parent value and later keys', () => {
    const first = setup();
    first.type('SELECT ');
    first.r.unmount();
    const second = setup({ initial: 'SELECT ' });
    second.type('1');
    expect(second.text()).toBe('SELECT 1');
    second.load('SELECT 7');
    expect(second.text()).toBe('SELECT 7');
  });
});
