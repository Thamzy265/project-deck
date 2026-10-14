import { fakeApp } from '@project-deck/core/testing';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { app2, fakeDaemon, renderDashboard } from '../testing/harness.js';

const log = (ts: number, message: string, level: 'info' | 'error' = 'info') => ({
  ts,
  level,
  source: 'app' as const,
  message,
});

describe('page states', () => {
  it('shows loading until connected, then the project, app and Logs tab', async () => {
    const t = renderDashboard();
    expect(screen.getByText('Loading FlutterDeck…')).toBeInTheDocument();
    await t.connect();
    expect(await screen.findByText('shop_app')).toHaveAttribute('title', 'shop_app');
    expect(screen.getByRole('combobox', { name: 'App' })).toHaveDisplayValue(
      'com.example.shop · Pixel 9 API 36 · IDE',
    );
    expect(screen.getByRole('tab', { name: 'Logs' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('contentinfo')).toHaveTextContent('Connected · v0.1.0');
    expect(screen.getByText('No reload yet')).toBeInTheDocument();
  });

  it('says the daemon is down when it never connected', async () => {
    const t = renderDashboard();
    t.client.status.mockRejectedValue(new TypeError('Failed to fetch'));
    await t.drop();
    expect(await screen.findByText(/Can't reach FlutterDeck/)).toBeInTheDocument();
  });

  it('reloads once on a refused cookie, then shows "Login needed"', async () => {
    const { HttpError } = await import('../api/client.js');
    const t = renderDashboard();
    t.client.status.mockRejectedValue(new HttpError(401, 'Missing or invalid token'));
    await t.drop();
    await waitFor(() => expect(t.reloadPage).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Reconnecting to FlutterDeck…')).toBeInTheDocument();
    t.unmount();

    // The reloaded page still can't log in.
    const again = renderDashboard();
    for (const [k, v] of t.session.items) again.session.setItem(k, v);
    again.client.status.mockRejectedValue(new HttpError(401, 'Missing or invalid token'));
    await again.drop();
    expect(await screen.findByText(/Login needed/)).toBeInTheDocument();
    expect(again.reloadPage).not.toHaveBeenCalled();
  });

  it('shows the retry banner and keeps the logs when the connection drops', async () => {
    const t = renderDashboard(fakeDaemon({ logs: [log(1, 'kept line')] }));
    await t.connect();
    await screen.findByText('kept line');
    t.client.status.mockRejectedValue(new TypeError('Failed to fetch'));
    await t.drop();
    expect(
      await screen.findByText('Lost connection to FlutterDeck — retrying (1)…'),
    ).toBeInTheDocument();
    expect(screen.getByText('kept line')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toHaveAttribute(
      'title',
      'Not connected',
    );
    expect(screen.getByRole('combobox', { name: 'App' })).toBeDisabled();
  });
});

describe('apps', () => {
  it('asks to pick an app when several run and none is attached', async () => {
    const t = renderDashboard(
      fakeDaemon({ status: { ...fakeDaemon().status, apps: [fakeApp(), app2], attached: null } }),
    );
    await t.connect();
    const picker = await screen.findByRole('combobox', { name: 'App' });
    expect(picker).toHaveDisplayValue('Pick an app');
    expect(screen.getByRole('button', { name: 'Reload' })).toHaveAttribute(
      'title',
      'No app attached',
    );
    await userEvent.selectOptions(picker, 'app-2');
    expect(t.client.attach).toHaveBeenCalledWith('app-2');
    await waitFor(() =>
      expect(picker).toHaveDisplayValue('com.example.admin · Pixel 9 API 36 · terminal'),
    );
  });

  it('says it is finding apps until discovery is done', async () => {
    const t = renderDashboard(
      fakeDaemon({
        status: { ...fakeDaemon().status, apps: [], attached: null, discovering: true },
      }),
    );
    await t.connect();
    expect(await screen.findByText('Finding apps…')).toBeInTheDocument();
    expect(screen.queryByText('No app running')).not.toBeInTheDocument();
    await t.send({ type: 'apps.discovering', payload: { discovering: false } });
    expect(screen.getByText('No app running')).toBeInTheDocument();
    expect(screen.queryByText('Finding apps…')).not.toBeInTheDocument();
  });

  it('explains how to start an app when none runs', async () => {
    const t = renderDashboard(
      fakeDaemon({ status: { ...fakeDaemon().status, apps: [], attached: null } }),
    );
    await t.connect();
    expect(await screen.findByText('No app running')).toBeInTheDocument();
    expect(screen.getByText(/FlutterDeck finds it automatically/)).toBeInTheDocument();
  });

  it('offers to try again when attaching fails', async () => {
    const t = renderDashboard(
      fakeDaemon({ status: { ...fakeDaemon().status, apps: [fakeApp(), app2], attached: null } }),
    );
    await t.connect();
    t.client.attach.mockRejectedValue(new Error('VM service closed'));
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'App' }), 'app-2');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't attach: VM service closed. Try again",
    );
    expect(
      screen.getByRole('button', { name: 'Try attaching to com.example.admin again' }),
    ).toBeInTheDocument();
  });

  it('says when the app stopped and keeps its logs', async () => {
    const t = renderDashboard(fakeDaemon({ logs: [log(1, 'before exit')] }));
    await t.connect();
    await screen.findByText('before exit');
    await t.send({ type: 'app.exit', payload: { appId: 'app-1', crashed: false } });
    expect(screen.getByText('App stopped — com.example.shop')).toBeInTheDocument();
    expect(screen.getByText('before exit')).toBeInTheDocument();
  });
});

describe('reload and restart', () => {
  it('reloads from the button and shows the result', async () => {
    const t = renderDashboard();
    await t.connect();
    await userEvent.click(await screen.findByRole('button', { name: 'Reload' }));
    expect(t.client.reload).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Reloaded in 182 ms')).toBeInTheDocument();
  });

  it('reloads with r and restarts with R, but not while typing', async () => {
    const t = renderDashboard();
    await t.connect();
    await screen.findByText('shop_app');
    await userEvent.keyboard('r');
    await waitFor(() => expect(t.client.reload).toHaveBeenCalledTimes(1));
    await userEvent.keyboard('{Shift>}R{/Shift}');
    await waitFor(() => expect(t.client.restart).toHaveBeenCalledTimes(1));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search logs' }), 'rR');
    expect(t.client.reload).toHaveBeenCalledTimes(1);
    expect(t.client.restart).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Reload' })).toHaveAttribute(
      'aria-keyshortcuts',
      'r',
    );
  });

  it('turns the shortcuts off from the ⋯ menu and remembers it', async () => {
    const t = renderDashboard();
    await t.connect();
    await userEvent.click(await screen.findByRole('button', { name: 'More log options' }));
    const sw = screen.getByRole('switch', { name: 'Keyboard shortcuts r / R: on' });
    sw.focus();
    await userEvent.keyboard(' ');
    expect(sw).toHaveAccessibleName('Keyboard shortcuts r / R: off');
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(t.prefs.getItem('flutterdeck.shortcuts')).toBe('off');
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard('r');
    expect(t.client.reload).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Reload' })).not.toHaveAttribute('aria-keyshortcuts');
  });

  it('shows "Reload failed" with the first error lines and links to Logs', async () => {
    const t = renderDashboard(
      fakeDaemon({
        reloadResult: {
          ok: false,
          reason: 'compile-error',
          message: 'lib/main.dart:3: Error: one\nlib/main.dart:4: Error: two\nthree\nfour',
        },
      }),
    );
    await t.connect();
    await userEvent.click(await screen.findByRole('button', { name: 'Reload' }));
    const chip = await screen.findByRole('button', { name: 'Last reload: failed, 3 errors' });
    expect(chip).toHaveTextContent('Reload failed');
    expect(screen.getByText('lib/main.dart:3: Error: one')).toBeInTheDocument();
    expect(screen.queryByText('four')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show in Logs' }));
    expect(screen.getByRole('combobox', { name: 'Level' })).toHaveDisplayValue('Error');
  });

  it('shows reloads made by Claude or the IDE', async () => {
    const t = renderDashboard();
    await t.connect();
    await t.send({
      type: 'app.reloaded',
      payload: { appId: 'app-1', result: { ok: true, kind: 'hot-reload', source: 'external' } },
    });
    expect(screen.getByText('Reloaded (from Claude or the IDE)')).toBeInTheDocument();
  });
});

describe('logs', () => {
  const daemon = () =>
    fakeDaemon({
      logs: [log(1, 'Tap 1'), log(2, 'Boom', 'error'), log(3, 'Tap 2')],
    });

  it('filters by level and text, with a count', async () => {
    const t = renderDashboard(daemon());
    await t.connect();
    await screen.findByText('Tap 1');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Level' }), 'error');
    expect(screen.queryByText('Tap 1')).not.toBeInTheDocument();
    expect(screen.getByText('Showing 1 of 3')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Level' }), 'all');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search logs' }), 'tap \\d');
    expect(await screen.findByText('Showing 2 of 3')).toBeInTheDocument();
  });

  it('explains an invalid pattern and leaves the list unchanged', async () => {
    const t = renderDashboard(daemon());
    await t.connect();
    await screen.findByText('Tap 1');
    const search = screen.getByRole('searchbox', { name: 'Search logs' });
    await userEvent.type(search, '[[(');
    expect(search).toHaveAttribute('aria-invalid', 'true');
    expect(search).toHaveAccessibleDescription("That pattern isn't valid");
    expect(screen.getByText('Tap 1')).toBeInTheDocument();
    expect(screen.getByText('Boom')).toBeInTheDocument();
  });

  it('refuses a pattern that could freeze the page (BUG-M2-T1)', async () => {
    const t = renderDashboard(daemon());
    await t.connect();
    await screen.findByText('Tap 1');
    const search = screen.getByRole('searchbox', { name: 'Search logs' });
    await userEvent.type(search, '(a+)+$');
    expect(search).toHaveAttribute('aria-invalid', 'true');
    expect(search).toHaveAccessibleDescription(
      'That pattern could freeze the page. Try a simpler one.',
    );
    expect(screen.getByText('Boom')).toBeInTheDocument();
  });

  it('offers to clear filters when nothing matches', async () => {
    const t = renderDashboard(daemon());
    await t.connect();
    await screen.findByText('Tap 1');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search logs' }), 'nothing');
    expect(
      await screen.findByText('No logs yet. Use your app, or clear filters'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('Tap 1')).toBeInTheDocument();
  });

  it('keeps lines that arrive between the clear event and the HTTP answer (review C1)', async () => {
    const t = renderDashboard(daemon());
    await t.connect();
    await screen.findByText('Tap 1');
    t.client.clearLogs.mockImplementation(async () => {
      const send = (m: unknown) => t.socket().onmessage?.({ data: JSON.stringify(m) });
      send({ type: 'logs.cleared', payload: { at: Date.now() } });
      send({ type: 'app.log', payload: { appId: 'app-1', entry: log(9, 'right after') } });
      // Let the batched line reach the list before the HTTP answer.
      await new Promise((r) => setTimeout(r, 100));
    });
    await userEvent.click(screen.getByRole('button', { name: 'More log options' }));
    await userEvent.click(screen.getByRole('button', { name: 'Clear logs' }));
    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Clear logs' }),
    );
    await waitFor(() => expect(t.client.clearLogs).toHaveBeenCalled());
    await act(() => new Promise((r) => setTimeout(r, 150)));
    expect(screen.getByText('right after')).toBeInTheDocument();
    expect(screen.queryByText('Tap 1')).not.toBeInTheDocument();
  });

  it('empties the list when another tab clears the logs (BUG-M2-T2)', async () => {
    const t = renderDashboard(daemon());
    await t.connect();
    await screen.findByText('Tap 1');
    await t.send({ type: 'logs.cleared', payload: { at: Date.now() } });
    expect(screen.queryByText('Tap 1')).not.toBeInTheDocument();
    expect(t.client.clearLogs).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('tab', { name: 'Activity' }));
    expect(screen.getByText('Logs cleared')).toBeInTheDocument();
  });

  it('adds lines from the socket', async () => {
    const t = renderDashboard();
    await t.connect();
    await t.send({ type: 'app.log', payload: { appId: 'app-1', entry: log(5, 'live line') } });
    expect(await screen.findByText('live line')).toBeInTheDocument();
  });

  it('collapses long entries behind "Show more"', async () => {
    const t = renderDashboard(fakeDaemon({ logs: [log(1, 'a\nb\nc\nd\ne\nf')] }));
    await t.connect();
    const more = await screen.findByRole('button', { name: /^Show more: / });
    const row = within(screen.getByRole('list', { name: 'Log lines' })).getByRole('listitem');
    expect(row).toHaveTextContent('a b c d');
    expect(row).not.toHaveTextContent('d e f');
    await userEvent.click(more);
    expect(row).toHaveTextContent('a b c d e f');
  });

  it('confirms before clearing, then notes it in Activity', async () => {
    const t = renderDashboard(daemon());
    await t.connect();
    await screen.findByText('Tap 1');
    await userEvent.click(screen.getByRole('button', { name: 'More log options' }));
    await userEvent.click(screen.getByRole('button', { name: 'Clear logs' }));
    const dialog = screen.getByRole('alertdialog', {
      name: "Clear all logs? This can't be undone.",
    });
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(t.client.clearLogs).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Clear logs' }));
    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Clear logs' }),
    );
    expect(t.client.clearLogs).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText('Tap 1')).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('tab', { name: 'Activity' }));
    expect(screen.getByText('Logs cleared')).toBeInTheDocument();
  });

  it('pauses on request and counts new lines until "Jump to latest"', async () => {
    const t = renderDashboard(daemon());
    await t.connect();
    expect(await screen.findByText('Following new logs')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'More log options' }));
    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await t.send({ type: 'app.log', payload: { appId: 'app-1', entry: log(9, 'new one') } });
    await act(() => new Promise((r) => setTimeout(r, 80)));
    expect(screen.getByText(/Paused — 1 new line/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Jump to latest' }));
    expect(screen.getByText('Following new logs')).toBeInTheDocument();
  });
});

describe('activity and tabs', () => {
  it('lists entries newest first and moves between tabs with arrow keys', async () => {
    const t = renderDashboard(
      fakeDaemon({
        activity: [
          { id: 0, ts: 1, kind: 'claude.done' },
          { id: 1, ts: 2, kind: 'claude.waiting', message: 'Allow Bash?' },
        ],
      }),
    );
    await t.connect();
    const logsTab = await screen.findByRole('tab', { name: 'Logs' });
    logsTab.focus();
    await userEvent.keyboard('{ArrowRight}');
    const activityTab = screen.getByRole('tab', { name: 'Activity' });
    expect(activityTab).toHaveFocus();
    expect(activityTab).toHaveAttribute('aria-selected', 'true');
    const items = within(screen.getByRole('list', { name: 'Activity' })).getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('Claude is waiting: Allow Bash?'),
      expect.stringContaining('Claude finished'),
    ]);
    await t.send({ type: 'activity', payload: { id: 2, ts: 3, kind: 'claude.done' } });
    expect(
      within(screen.getByRole('list', { name: 'Activity' })).getAllByRole('listitem'),
    ).toHaveLength(3);
  });

  it('shows an empty Activity tab', async () => {
    const t = renderDashboard();
    await t.connect();
    await userEvent.click(await screen.findByRole('tab', { name: 'Activity' }));
    expect(
      screen.getByText("Nothing yet. Reloads, crashes and Claude's progress appear here"),
    ).toBeInTheDocument();
  });
});
