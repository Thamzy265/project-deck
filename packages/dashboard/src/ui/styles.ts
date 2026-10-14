/** Shared class lists, so every control looks and behaves the same. */

/** At least 24 × 24 px (WCAG 2.5.8); tint on hover; `aria-disabled` dims but stays focusable. */
export const button =
  'inline-flex min-h-6 items-center justify-center gap-1 rounded-sm border border-border bg-bg px-2 text-text hover:bg-surface aria-disabled:cursor-not-allowed aria-disabled:opacity-60 disabled:cursor-not-allowed disabled:opacity-60';

/** Header buttons are 32 px high (UI spec, "Targets"). */
export const headerButton = `${button} min-h-8`;

/** Text-only buttons inside messages, like "Retry" or "Show more". */
export const linkButton =
  'inline-flex min-h-6 items-center rounded-sm px-1 text-accent underline hover:bg-surface';

export const field =
  'min-h-8 min-w-0 rounded-sm border border-border bg-bg px-2 text-text hover:bg-surface';

export const srOnly = 'sr-only';
