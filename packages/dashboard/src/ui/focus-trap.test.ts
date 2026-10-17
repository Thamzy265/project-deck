// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { tabStops, trapTab } from './focus-trap.js';

function setup(): HTMLElement {
  document.body.innerHTML = `
    <button id="out-before">Out</button>
    <section id="box">
      <h2 id="title" tabindex="-1">Title</h2>
      <button id="close">Close</button>
      <input id="disabled" disabled>
      <div inert><button id="inert">Inert</button></div>
      <input id="field">
      <button id="save">Save</button>
    </section>
    <button id="out-after">Out</button>`;
  const box = document.getElementById('box');
  if (box === null) throw new Error('no box');
  return box;
}

function tab(box: HTMLElement, from: string, shiftKey = false) {
  document.getElementById(from)?.focus();
  let prevented = false;
  const moved = trapTab({ key: 'Tab', shiftKey, preventDefault: () => (prevented = true) }, box);
  return { moved, prevented, focused: document.activeElement?.id };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('focus trap (review L1)', () => {
  it('lists only the reachable stops, in order', () => {
    expect(tabStops(setup()).map((el) => el.id)).toEqual(['close', 'field', 'save']);
  });

  it('wraps Tab from the last stop to the first', () => {
    expect(tab(setup(), 'save')).toEqual({ moved: true, prevented: true, focused: 'close' });
  });

  it('wraps Shift+Tab from the first stop, or the heading before it, to the last', () => {
    const box = setup();
    expect(tab(box, 'close', true)).toEqual({ moved: true, prevented: true, focused: 'save' });
    expect(tab(box, 'title', true)).toEqual({ moved: true, prevented: true, focused: 'save' });
  });

  it('leaves Tab between inner stops to the browser', () => {
    const box = setup();
    expect(tab(box, 'close').moved).toBe(false);
    expect(tab(box, 'title').moved).toBe(false);
    expect(tab(box, 'save', true).moved).toBe(false);
  });

  it('brings focus that is outside the box back in', () => {
    const box = setup();
    expect(tab(box, 'out-after').focused).toBe('close');
    expect(tab(box, 'out-before', true).focused).toBe('save');
  });

  it('ignores other keys', () => {
    const box = setup();
    document.getElementById('save')?.focus();
    expect(trapTab({ key: 'Enter', shiftKey: false, preventDefault: () => undefined }, box)).toBe(
      false,
    );
  });
});
