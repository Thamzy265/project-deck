import { useEffect } from 'react';
import type { ActionKind } from '../state/deck.js';

/** Typing in these must never reload the app. */
function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * `r` reloads and Shift+R restarts, unless switched off (WCAG 2.2 SC 2.1.4), focus is in a
 * text field, a modal is open, or a modifier other than Shift is held.
 */
export function useShortcuts(enabled: boolean, run: (kind: ActionKind) => void): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTextField(event.target)) return;
      if (document.querySelector('[aria-modal="true"]') !== null) return;
      // Shift decides, not the letter's case: with Caps Lock on, "R" must not restart.
      if (event.key === 'r' && !event.shiftKey) run('reload');
      else if (event.key === 'R' && event.shiftKey) run('restart');
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, run]);
}
