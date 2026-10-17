import { useSyncExternalStore } from 'react';

/** UI spec breakpoints: 320 px (narrow), 420 px (the pane), ≥ 900 px (sidebar). */
export const PANE_QUERY = '(min-width: 25rem)';
export const WIDE_QUERY = '(min-width: 56.25rem)';
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Whether a media query matches, kept up to date. Without matchMedia (jsdom) the
 * answer is `fallback`.
 */
export function useMedia(query: string, fallback: boolean): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== 'function') return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => (typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : fallback),
  );
}
