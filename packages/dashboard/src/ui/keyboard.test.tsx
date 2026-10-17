/**
 * Keyboard paths from the UI spec ("Accessibility notes"): when r / R may fire, the focus
 * order, the confirm dialog and the tabs.
 */
import type { ReloadResult } from '@project-deck/core';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { app2, fakeDaemon, renderDashboard } from '../testing/harness.js';

const log = (ts: number, message: string) => ({
  ts,
  level: 'info' as const,
  source: 'app' as const,
  message,
});

async function ready(daemon = fakeDaemon({ logs: [log(1, 'Tap 1')] })) {
  const t = renderDashboard(daemon);
  await t.connect();
  await screen.findByText('shop_app');
  return { ...t, user: userEvent.setup() };
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'More log options' }));
}

describe('r and R', () => {
  it('restart only with Shift, so Caps Lock never restarts (review C8)', async () => {
    const t = await ready();
    screen.getByRole('tab', { name: 'Logs' }).focus();
    // Caps Lock on: the key is "R" but Shift isn't held.
    fireEvent.keyDown(window, { key: 'R', shiftKey: false });
    // Shift with a layout that still reports "r".
    fireEvent.keyDown(window, { key: 'r', shiftKey: true });
    await act(() => Promise.resolve());
    expect(t.client.restart).not.toHaveBeenCalled();
    expect(t.client.reload).not.toHaveBeenCalled();
  });

  it('do nothing while focus is in the level select', async () => {
    const t = await ready();
    screen.getByRole('combobox', { name: 'Level' }).focus();
    await t.user.keyboard('rR');
    expect(t.client.reload).not.toHaveBeenCalled();
    expect(t.client.restart).not.toHaveBeenCalled();
  });

  it('do nothing while focus is in the app picker', async () => {
    const t = await ready();
    screen.getByRole('combobox', { name: 'App' }).focus();
    await t.user.keyboard('rR');
    expect(t.client.reload).not.toHaveBeenCalled();
    expect(t.client.restart).not.toHaveBeenCalled();
  });

  it('do nothing in the selects and checkbox of the ⋯ menu', async () => {
    const t = await ready();
    await openMenu(t.user);
    for (const control of [
      screen.getByRole('combobox', { name: 'Source' }),
      screen.getByRole('combobox', { name: 'Tag' }),
      screen.getByRole('checkbox', { name: 'Since last reload' }),
    ]) {
      control.focus();
      await t.user.keyboard('rR');
    }
    expect(t.client.reload).not.toHaveBeenCalled();
    expect(t.client.restart).not.toHaveBeenCalled();
  });

  it('do nothing while the clear-logs dialog is open, wherever focus is', async () => {
    const t = await ready();
    await openMenu(t.user);
    await t.user.click(screen.getByRole('button', { name: 'Clear logs' }));
    const dialog = screen.getByRole('alertdialog');
    await t.user.keyboard('rR');
    within(dialog).getByRole('button', { name: 'Clear logs' }).focus();
    await t.user.keyboard('rR');
    // Focus escaped to the page behind the dialog: the modal still blocks the keys.
    (document.activeElement as HTMLElement | null)?.blur();
    await t.user.keyboard('rR');
    expect(t.client.reload).not.toHaveBeenCalled();
    expect(t.client.restart).not.toHaveBeenCalled();
  });

  it('ignore Ctrl, Cmd and Alt, so the browser reload still works', async () => {
    const t = await ready();
    await t.user.keyboard('{Control>}r{/Control}{Meta>}r{/Meta}{Alt>}r{/Alt}{Meta>}R{/Meta}');
    expect(t.client.reload).not.toHaveBeenCalled();
    expect(t.client.restart).not.toHaveBeenCalled();
  });

  it('a held key reloads once', async () => {
    const t = await ready();
    await t.user.keyboard('{r>5/}');
    await waitFor(() => expect(t.client.reload).toHaveBeenCalledTimes(1));
  });

  it('a second r while a reload runs does not start another', async () => {
    const t = await ready();
    t.client.reload.mockReturnValue(new Promise<ReloadResult>(() => undefined));
    await t.user.keyboard('r');
    expect(await screen.findByText('Reloading…')).toBeInTheDocument();
    await t.user.keyboard('rR');
    expect(t.client.reload).toHaveBeenCalledTimes(1);
    expect(t.client.restart).not.toHaveBeenCalled();
  });

  it('do nothing while the connection is lost', async () => {
    const t = await ready();
    t.client.status.mockRejectedValue(new TypeError('Failed to fetch'));
    await t.drop();
    await screen.findByText(/Lost connection/);
    await t.user.keyboard('rR');
    expect(t.client.reload).not.toHaveBeenCalled();
    expect(t.client.restart).not.toHaveBeenCalled();
  });

  it('do nothing when no app is attached', async () => {
    const base = fakeDaemon();
    const t = await ready(fakeDaemon({ status: { ...base.status, attached: null } }));
    await t.user.keyboard('rR');
    expect(t.client.reload).not.toHaveBeenCalled();
  });

  it('work while focus is on a button or the log list', async () => {
    const t = await ready();
    screen.getByRole('tab', { name: 'Logs' }).focus();
    await t.user.keyboard('r');
    await waitFor(() => expect(t.client.reload).toHaveBeenCalledTimes(1));
    await screen.findByText('Reloaded in 182 ms');
    screen.getByRole('list', { name: 'Log lines' }).focus();
    await t.user.keyboard('{Shift>}R{/Shift}');
    await waitFor(() => expect(t.client.restart).toHaveBeenCalledTimes(1));
  });

  it('when off, hide the key hints and aria-keyshortcuts on both buttons', async () => {
    const t = await ready();
    const reload = screen.getByRole('button', { name: 'Reload' });
    expect(reload).toHaveTextContent('r');
    expect(screen.getByRole('button', { name: 'Restart' })).toHaveAttribute(
      'aria-keyshortcuts',
      'Shift+R',
    );
    await openMenu(t.user);
    await t.user.click(screen.getByRole('switch', { name: /Keyboard shortcuts/ }));
    for (const name of ['Reload', 'Restart']) {
      const b = screen.getByRole('button', { name });
      expect(b).not.toHaveAttribute('aria-keyshortcuts');
      expect(b.querySelector('kbd')).toBeNull();
    }
    screen.getByRole('tab', { name: 'Logs' }).focus();
    await t.user.keyboard('rR');
    expect(t.client.reload).not.toHaveBeenCalled();
    expect(t.client.restart).not.toHaveBeenCalled();
  });

  it('stay off on the next page load when storage remembered it', async () => {
    const t = await ready();
    await openMenu(t.user);
    await t.user.click(screen.getByRole('switch', { name: /Keyboard shortcuts/ }));
    t.unmount();
    const again = renderDashboard(fakeDaemon(), t.prefs);
    await again.connect();
    await screen.findByText('shop_app');
    await userEvent.setup().keyboard('r');
    expect(again.client.reload).not.toHaveBeenCalled();
  });
});

describe('focus order and dialogs', () => {
  it('follows the spec: skip link, picker, Reload, Restart, tabs, filters, list', async () => {
    const t = await ready();
    document.body.focus();
    const expected = [
      screen.getByRole('link', { name: 'Skip to logs' }),
      screen.getByRole('combobox', { name: 'App' }),
      screen.getByRole('button', { name: 'Reload' }),
      screen.getByRole('button', { name: 'Restart' }),
      screen.getByRole('tab', { name: 'Logs' }),
      screen.getByRole('searchbox', { name: 'Search logs' }),
      screen.getByRole('combobox', { name: 'Level' }),
      screen.getByRole('button', { name: 'More log options' }),
      screen.getByRole('list', { name: 'Log lines' }),
    ];
    const seen: (Element | null)[] = [];
    for (let i = 0; i < expected.length; i++) {
      await t.user.tab();
      seen.push(document.activeElement);
    }
    expect(seen).toEqual(expected);
  });

  it('puts the failed result chip after Restart in the focus order', async () => {
    const t = await ready(
      fakeDaemon({ reloadResult: { ok: false, reason: 'compile-error', message: 'boom' } }),
    );
    await t.user.click(screen.getByRole('button', { name: 'Reload' }));
    const chip = await screen.findByRole('button', { name: 'Last reload: failed, 1 error' });
    screen.getByRole('button', { name: 'Restart' }).focus();
    await t.user.tab();
    expect(chip).toHaveFocus();
    await t.user.keyboard('{Enter}');
    expect(chip).toHaveAttribute('aria-expanded', 'false');
  });

  it('the skip link moves focus to the log list', async () => {
    const t = await ready();
    document.body.focus();
    await t.user.tab();
    await t.user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('list', { name: 'Log lines' })).toHaveFocus());
  });

  it('the dialog traps Tab, closes on Escape and gives focus back to ⋯', async () => {
    const t = await ready();
    await openMenu(t.user);
    await t.user.click(screen.getByRole('button', { name: 'Clear logs' }));
    const dialog = screen.getByRole('alertdialog');
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    const confirm = within(dialog).getByRole('button', { name: 'Clear logs' });
    expect(cancel).toHaveFocus();
    await t.user.tab();
    expect(confirm).toHaveFocus();
    await t.user.tab();
    expect(cancel).toHaveFocus();
    await t.user.tab({ shift: true });
    expect(confirm).toHaveFocus();
    await t.user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'More log options' })).toHaveFocus();
    // Escape closed only the dialog; the menu is still open.
    expect(screen.getByRole('button', { name: 'More log options' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(t.client.clearLogs).not.toHaveBeenCalled();
  });

  it('Enter on the dialog confirm clears and returns focus to ⋯', async () => {
    const t = await ready();
    await openMenu(t.user);
    await t.user.click(screen.getByRole('button', { name: 'Clear logs' }));
    await t.user.tab();
    await t.user.keyboard('{Enter}');
    expect(t.client.clearLogs).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'More log options' })).toHaveFocus();
  });

  it('Escape closes the ⋯ menu and gives focus back to its button', async () => {
    const t = await ready();
    await openMenu(t.user);
    screen.getByRole('combobox', { name: 'Source' }).focus();
    await t.user.keyboard('{Escape}');
    const more = screen.getByRole('button', { name: 'More log options' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(more).toHaveFocus();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('Space toggles the shortcuts switch', async () => {
    const t = await ready();
    await openMenu(t.user);
    const sw = screen.getByRole('switch', { name: /Keyboard shortcuts/ });
    sw.focus();
    await t.user.keyboard(' ');
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await t.user.keyboard(' ');
    expect(sw).toHaveAttribute('aria-checked', 'true');
  });
});

describe('tabs', () => {
  it('ArrowLeft wraps, Home and End jump, and only the selected tab is in the Tab order', async () => {
    const t = await ready();
    const database = screen.getByRole('tab', { name: 'Database' });
    const logs = screen.getByRole('tab', { name: 'Logs' });
    const activity = screen.getByRole('tab', { name: 'Activity' });
    logs.focus();
    await t.user.keyboard('{ArrowLeft}');
    expect(database).toHaveFocus();
    expect(database).toHaveAttribute('tabindex', '0');
    expect(logs).toHaveAttribute('tabindex', '-1');
    await t.user.keyboard('{ArrowLeft}');
    expect(activity).toHaveFocus();
    await t.user.keyboard('{Home}');
    expect(database).toHaveFocus();
    expect(database).toHaveAttribute('aria-selected', 'true');
    await t.user.keyboard('{End}');
    expect(activity).toHaveFocus();
    await t.user.keyboard('{ArrowRight}');
    expect(database).toHaveFocus();
    await t.user.keyboard('{ArrowRight}');
    expect(logs).toHaveFocus();
    // Other keys do nothing.
    await t.user.keyboard('{ArrowDown}');
    expect(logs).toHaveFocus();
    expect(screen.getByRole('tabpanel', { name: 'Logs' })).toBeVisible();
  });

  it('Enter on a long log line expands it, but not on its buttons', async () => {
    const t = await ready(fakeDaemon({ logs: [log(1, 'a\nb\nc\nd\ne\nf')] }));
    const row = within(screen.getByRole('list', { name: 'Log lines' })).getByRole('listitem');
    screen.getByRole('button', { name: /^Copy line/ }).focus();
    await t.user.keyboard('{Enter}');
    expect(row).not.toHaveTextContent('e f');
    act(() => row.focus());
    await t.user.keyboard('{Enter}');
    expect(row).toHaveTextContent('a b c d e f');
  });

  it('switching tabs keeps the app choice and the menu state', async () => {
    const base = fakeDaemon();
    const t = await ready(
      fakeDaemon({ status: { ...base.status, apps: [...base.status.apps, app2] } }),
    );
    await openMenu(t.user);
    await t.user.click(screen.getByRole('tab', { name: 'Activity' }));
    await t.user.click(screen.getByRole('tab', { name: 'Logs' }));
    expect(screen.getByRole('switch', { name: /Keyboard shortcuts/ })).toBeInTheDocument();
  });
});
