const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** A box that scrolls and holds nothing focusable: Chromium gives it a Tab stop. */
function scrollStop(el: HTMLElement): boolean {
  if (el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth) return false;
  const { overflowX, overflowY } = getComputedStyle(el);
  if (![overflowX, overflowY].some((o) => o === 'auto' || o === 'scroll')) return false;
  return el.querySelector(FOCUSABLE) === null;
}

/** The Tab stops inside `box`, in document order. */
export function tabStops(box: HTMLElement): HTMLElement[] {
  return [...box.querySelectorAll<HTMLElement>('*')].filter(
    (el) =>
      el.closest('[inert]') === null &&
      el.getAttribute('aria-hidden') !== 'true' &&
      (el.matches(FOCUSABLE) || scrollStop(el)),
  );
}

/**
 * Keeps Tab and Shift+Tab inside a modal box (WAI-ARIA dialog pattern): from its last
 * stop Tab goes to its first, and from its first (or anything before it, such as a
 * heading focused by script) Shift+Tab goes to its last. Returns true when it moved.
 */
export function trapTab(
  event: { key: string; shiftKey: boolean; preventDefault: () => void },
  box: HTMLElement,
): boolean {
  if (event.key !== 'Tab') return false;
  const stops = tabStops(box);
  const active = document.activeElement;
  const first = stops[0];
  const last = stops.at(-1);
  if (first === undefined || last === undefined) {
    event.preventDefault();
    return true;
  }
  const inside = active !== null && box.contains(active);
  const before = (el: HTMLElement) =>
    active !== null &&
    (active.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) !== 0 &&
    !el.contains(active);
  const after = (el: HTMLElement) =>
    active !== null &&
    (active.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
    !el.contains(active);
  if (event.shiftKey) {
    if (inside && stops.some((el) => before(el) && el !== active)) return false;
    event.preventDefault();
    last.focus();
    return true;
  }
  if (inside && stops.some((el) => after(el) && el !== active)) return false;
  event.preventDefault();
  first.focus();
  return true;
}
