import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeDaemon, renderDashboard } from '../../testing/harness.js';

const LONG = `token=${'x'.repeat(2000)}`;

/** jsdom has no layout: make the long line's text box taller than four rows. */
function layout(): () => void {
  const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
  const client = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  Object.defineProperties(HTMLElement.prototype, {
    scrollHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return this.textContent.startsWith('token=') ? 400 : 20;
      },
    },
    clientHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return this.textContent.startsWith('token=') ? 80 : 20;
      },
    },
  });
  return () => {
    if (scroll !== undefined) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scroll);
    if (client !== undefined) Object.defineProperty(HTMLElement.prototype, 'clientHeight', client);
  };
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

describe('a single long line (QA B2-3)', () => {
  it('collapses past four rows on screen with "Show more"', async () => {
    restore = layout();
    const t = renderDashboard(
      fakeDaemon({
        logs: [
          { ts: 1, level: 'info', source: 'app', message: LONG },
          { ts: 2, level: 'info', source: 'app', message: 'short' },
        ],
      }),
    );
    await t.connect();
    await screen.findByText('short');
    const list = screen.getByRole('list', { name: 'Log lines' });
    const more = within(list).getAllByRole('button', { name: /^Show more: / });
    expect(more).toHaveLength(1);
    const text = screen.getByText(LONG);
    expect(text).toHaveClass('line-clamp-4');
    await userEvent.click(more[0] ?? document.body);
    expect(screen.getByText(LONG)).not.toHaveClass('line-clamp-4');
    expect(within(list).queryByRole('button', { name: /^Show more: / })).toBeNull();
  });
});
