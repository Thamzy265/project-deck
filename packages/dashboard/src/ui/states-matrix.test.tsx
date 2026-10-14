/**
 * Cells of the UI spec's states matrix (docs/ui/m2-dashboard.md) that App.test.tsx does
 * not cover. Each test names its row and column.
 */
import type { ActivityList, LogsResult, ReloadResult, RunningApp } from '@project-deck/core';
import { fakeApp } from '@project-deck/core/testing';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app2, fakeDaemon, renderDashboard } from '../testing/harness.js';

const log = (ts: number, message: string, level: 'info' | 'error' = 'info') => ({
  ts,
  level,
  source: 'app' as const,
  message,
});

const never = <T,>() => new Promise<T>(() => undefined);

async function ready(daemon = fakeDaemon({ logs: [log(1, 'Tap 1')] })) {
  const t = renderDashboard(daemon);
  await t.connect();
  await screen.findByText(daemon.status.projectName);
  return { ...t, user: userEvent.setup() };
}

async function goOffline(t: Awaited<ReturnType<typeof ready>>) {
  t.client.status.mockRejectedValue(new TypeError('Failed to fetch'));
  await t.drop();
  await screen.findByText(/Lost connection to FlutterDeck — retrying \(1\)…/);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('App picker', () => {
  it('Disabled: while attach runs, with a spinner', async () => {
    const base = fakeDaemon();
    const t = await ready(
      fakeDaemon({ status: { ...base.status, apps: [...base.status.apps, app2] } }),
    );
    t.client.attach.mockReturnValue(never<RunningApp>());
    await t.user.selectOptions(screen.getByRole('combobox', { name: 'App' }), 'app-2');
    expect(screen.getByRole('combobox', { name: 'App' })).toBeDisabled();
    expect(t.client.attach).toHaveBeenCalledWith('app-2');
  });

  it('Success: the picker shows the new app once attached', async () => {
    const base = fakeDaemon();
    const t = await ready(
      fakeDaemon({ status: { ...base.status, apps: [...base.status.apps, app2] } }),
    );
    await t.user.selectOptions(screen.getByRole('combobox', { name: 'App' }), 'app-2');
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'App' })).toHaveDisplayValue(
        'com.example.admin · Pixel 9 API 36 · terminal',
      ),
    );
    expect(screen.getByRole('combobox', { name: 'App' })).toBeEnabled();
    await t.send({
      type: 'activity',
      payload: { id: 9, ts: 5, kind: 'app.attached', appId: 'app-2', appName: app2.name },
    });
    await t.user.click(screen.getByRole('tab', { name: 'Activity' }));
    expect(screen.getByText('Attached to com.example.admin')).toBeInTheDocument();
  });

  it('Long content: the full name is in the title of the picker and its option', async () => {
    const long = fakeApp({ name: `com.example.${'very_long_name_'.repeat(10)}` });
    const base = fakeDaemon();
    await ready(fakeDaemon({ status: { ...base.status, apps: [long], attached: long } }));
    const picker = screen.getByRole('combobox', { name: 'App' });
    expect(picker.getAttribute('title')).toContain(long.name);
    expect(within(picker).getByRole('option').getAttribute('title')).toContain(long.name);
  });

  it('Offline: disabled, still showing the last app after it stopped', async () => {
    const t = await ready();
    await t.send({ type: 'app.exit', payload: { appId: 'app-1', crashed: false } });
    await t.send({ type: 'apps.changed', payload: { connectorId: 'fake', apps: [] } });
    await goOffline(t);
    const picker = screen.getByRole('combobox', { name: 'App' });
    expect(picker).toBeDisabled();
    expect(picker).toHaveDisplayValue('com.example.shop · Pixel 9 API 36 · IDE');
  });
});

describe('Reload / Restart buttons', () => {
  it('Disabled: no app attached, with the reason as a tooltip, and clicks do nothing', async () => {
    const base = fakeDaemon();
    const t = await ready(fakeDaemon({ status: { ...base.status, attached: null } }));
    for (const name of ['Reload', 'Restart']) {
      const b = screen.getByRole('button', { name });
      expect(b).toHaveAttribute('aria-disabled', 'true');
      expect(b).toHaveAttribute('title', 'No app attached');
      await t.user.click(b);
    }
    expect(t.client.reload).not.toHaveBeenCalled();
    expect(t.client.restart).not.toHaveBeenCalled();
  });

  it('Loading: "Reloading…" with a spinner, still focusable, and a second click is ignored', async () => {
    const t = await ready();
    t.client.reload.mockReturnValue(never<ReloadResult>());
    await t.user.click(screen.getByRole('button', { name: 'Reload' }));
    const busy = screen.getByRole('button', { name: 'Reloading…' });
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    expect(busy).toHaveAttribute('title', 'A reload is running');
    expect(busy).not.toBeDisabled();
    busy.focus();
    expect(busy).toHaveFocus();
    await t.user.click(busy);
    await t.user.click(screen.getByRole('button', { name: 'Restart' }));
    expect(t.client.reload).toHaveBeenCalledTimes(1);
    expect(t.client.restart).not.toHaveBeenCalled();
  });

  it('Loading: "Restarting…" for a restart', async () => {
    const t = await ready();
    t.client.restart.mockReturnValue(never<ReloadResult>());
    await t.user.click(screen.getByRole('button', { name: 'Restart' }));
    expect(screen.getByRole('button', { name: 'Restarting…' })).toBeInTheDocument();
  });

  it('Empty: hidden with "Reload not available for this app" when the app answers unsupported', async () => {
    const t = await ready(
      fakeDaemon({ reloadResult: { ok: false, reason: 'unsupported', message: 'no' } }),
    );
    await t.user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(await screen.findByText('Reload not available for this app')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull();
  });

  it('Success: green "Reloaded in 182 ms" for 10 s, then "Last reload HH:MM"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const t = renderDashboard();
    await t.connect();
    await screen.findByText('shop_app');
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(await screen.findByText('Reloaded in 182 ms')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(screen.getByText('Reloaded in 182 ms')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(screen.queryByText('Reloaded in 182 ms')).toBeNull();
    expect(screen.getByText(/^Last reload \d\d:\d\d$/)).toBeInTheDocument();
  });

  it('Offline: both buttons say "Not connected"', async () => {
    const t = await ready();
    await goOffline(t);
    for (const name of ['Reload', 'Restart']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('title', 'Not connected');
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-disabled', 'true');
    }
  });
});

describe('Result chip', () => {
  it('Error: at most 3 error log lines since the reload, one line each', async () => {
    const t = await ready(
      fakeDaemon({ reloadResult: { ok: false, reason: 'compile-error', message: 'fallback' } }),
    );
    // Error lines logged while the reload runs. Their device times are in the past on
    // purpose: only the daemon's order counts (review C2).
    t.client.reload.mockImplementation(async () => {
      for (let i = 1; i <= 5; i++) {
        const entry = { ...log(1000 + i, `err ${i}\nsecond line`, 'error'), seq: 100 + i };
        t.socket().onmessage?.({
          data: JSON.stringify({ type: 'app.log', payload: { appId: 'app-1', entry } }),
        });
      }
      await new Promise((r) => setTimeout(r, 80));
      return { ok: false, reason: 'compile-error', message: 'fallback' };
    });
    await t.user.click(screen.getByRole('button', { name: 'Reload' }));
    const chip = await screen.findByRole('button', { name: 'Last reload: failed, 3 errors' });
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    const errors = document.getElementById('reload-errors');
    expect(errors).not.toBeNull();
    const lines = within(errors ?? document.body).getAllByRole('listitem');
    expect(lines.map((l) => l.textContent)).toEqual(['err 1', 'err 2', 'err 3']);
    expect(lines.map((l) => l.getAttribute('title'))).toEqual(['err 1', 'err 2', 'err 3']);
    expect(screen.queryByText('fallback')).toBeNull();
    await t.user.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'false');
  });

  it('Error: a failed HTTP call shows the reason and frees the buttons', async () => {
    const t = await ready();
    t.client.reload.mockRejectedValue(new Error('The operation timed out.'));
    await t.user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(await screen.findByText('The operation timed out.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).not.toHaveAttribute('aria-disabled');
  });

  it('Offline: hidden', async () => {
    const t = await ready();
    expect(screen.getByText('No reload yet')).toBeInTheDocument();
    await goOffline(t);
    expect(screen.queryByText('No reload yet')).toBeNull();
  });
});

describe('Tabs', () => {
  it('Offline: still switchable', async () => {
    const t = await ready();
    await goOffline(t);
    await t.user.click(screen.getByRole('tab', { name: 'Activity' }));
    expect(screen.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('Logs list', () => {
  it('Loading: skeleton rows on first load', async () => {
    const t = renderDashboard();
    t.client.logs.mockReturnValue(never<LogsResult>());
    await t.connect();
    expect(await screen.findByRole('status', { name: 'Loading logs' })).toBeInTheDocument();
  });

  it('Error: "Couldn\'t load logs: <reason>. Retry" and Retry loads them', async () => {
    const t = renderDashboard(fakeDaemon({ logs: [log(1, 'back again')] }));
    t.client.logs.mockRejectedValueOnce(new Error('HTTP 500'));
    await t.connect();
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load logs: HTTP 500.");
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('back again')).toBeInTheDocument();
  });

  it('Hover/Focus: the copy button copies the whole entry, stack included', async () => {
    const t = await ready(
      fakeDaemon({
        logs: [{ ...log(1, 'Boom'), stack: '#0 main (package:app/main.dart:3:5)' }],
      }),
    );
    await t.user.click(screen.getByRole('button', { name: /^Copy line: .*Boom/ }));
    expect(await navigator.clipboard.readText()).toBe('Boom\n#0 main (package:app/main.dart:3:5)');
  });

  it('Long content: a line from the socket while the first load runs is not lost', async () => {
    let answer: (r: LogsResult) => void = () => undefined;
    const t = renderDashboard(fakeDaemon());
    t.client.logs.mockReturnValue(new Promise((r) => (answer = r)));
    await t.connect();
    await t.send({ type: 'app.log', payload: { appId: 'app-1', entry: log(5, 'live') } });
    await act(() => new Promise((r) => setTimeout(r, 80)));
    await act(async () => {
      answer({ entries: [log(1, 'old'), log(5, 'live')], truncated: false });
      await Promise.resolve();
    });
    const list = await screen.findByRole('list', { name: 'Log lines' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((r) => r.textContent),
    ).toEqual([expect.stringContaining('old'), expect.stringContaining('live')]);
  });
});

describe('Log filters', () => {
  it('Offline: usable on the lines already shown', async () => {
    const t = await ready(fakeDaemon({ logs: [log(1, 'Tap 1'), log(2, 'Boom', 'error')] }));
    await goOffline(t);
    await t.user.type(screen.getByRole('searchbox', { name: 'Search logs' }), 'boom');
    expect(screen.getByText('Showing 1 of 2')).toBeInTheDocument();
  });

  it('Error: the error clears once the pattern is valid again', async () => {
    const t = await ready();
    const search = screen.getByRole('searchbox', { name: 'Search logs' });
    await t.user.type(search, '(');
    expect(search).toHaveAttribute('aria-describedby', 'log-search-error');
    await t.user.type(search, ')');
    expect(search).toHaveAttribute('aria-invalid', 'false');
    expect(search).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByText("That pattern isn't valid")).toBeNull();
  });

  it('Long content: the search box limits a pattern to 200 characters', async () => {
    await ready();
    expect(screen.getByRole('searchbox', { name: 'Search logs' })).toHaveAttribute(
      'maxLength',
      '200',
    );
  });
});

describe('Clear logs', () => {
  it('Disabled: with no logs, the item is aria-disabled and opens no dialog', async () => {
    const t = await ready(fakeDaemon());
    await t.user.click(screen.getByRole('button', { name: 'More log options' }));
    const clear = screen.getByRole('button', { name: 'Clear logs' });
    expect(clear).toHaveAttribute('aria-disabled', 'true');
    expect(clear).toHaveAttribute('title', 'No logs');
    await t.user.click(clear);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('Error: "Couldn\'t clear logs" and the lines stay', async () => {
    const t = await ready();
    t.client.clearLogs.mockRejectedValue(new Error('HTTP 500'));
    await t.user.click(screen.getByRole('button', { name: 'More log options' }));
    await t.user.click(screen.getByRole('button', { name: 'Clear logs' }));
    await t.user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Clear logs' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't clear logs");
    expect(screen.getByText('Tap 1')).toBeInTheDocument();
  });

  it('Offline: disabled', async () => {
    const t = await ready();
    await t.user.click(screen.getByRole('button', { name: 'More log options' }));
    await goOffline(t);
    const clear = screen.getByRole('button', { name: 'Clear logs' });
    expect(clear).toHaveAttribute('aria-disabled', 'true');
    await t.user.click(clear);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('Activity list', () => {
  it('Loading: skeleton rows', async () => {
    const t = renderDashboard();
    t.client.activity.mockReturnValue(never<ActivityList>());
    await t.connect();
    await userEvent.setup().click(await screen.findByRole('tab', { name: 'Activity' }));
    expect(screen.getByRole('status', { name: 'Loading activity' })).toBeInTheDocument();
  });

  it('Error: "Couldn\'t load activity. Retry" and Retry loads it', async () => {
    const t = renderDashboard(fakeDaemon({ activity: [{ id: 0, ts: 1, kind: 'claude.done' }] }));
    t.client.activity.mockRejectedValueOnce(new Error('HTTP 500'));
    await t.connect();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Activity' }));
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load activity.");
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Claude finished')).toBeInTheDocument();
  });

  it('Default: icons and text for every kind, failures marked in text', async () => {
    const app = { appId: 'app-1', appName: 'shop' };
    const t = await ready(
      fakeDaemon({
        activity: [
          { id: 0, ts: 1, kind: 'claude.done' },
          { id: 1, ts: 2, kind: 'claude.waiting' },
          { id: 2, ts: 3, kind: 'app.stopped', ...app },
          { id: 3, ts: 4, kind: 'app.crashed', ...app },
          { id: 4, ts: 5, kind: 'app.detached', ...app },
          {
            id: 5,
            ts: 6,
            kind: 'app.reloaded',
            ...app,
            result: { ok: false, reason: 'compile-error', message: 'x' },
          },
          {
            id: 6,
            ts: 7,
            kind: 'app.reloaded',
            ...app,
            result: { ok: true, kind: 'hot-reload', durationMs: 5 },
          },
        ],
      }),
    );
    await t.user.click(screen.getByRole('tab', { name: 'Activity' }));
    const items = within(screen.getByRole('list', { name: 'Activity' })).getAllByRole('listitem');
    expect(items.map((i) => i.querySelector('p')?.textContent)).toEqual([
      'Reloaded in 5 ms',
      'Reload failed',
      'Detached from shop',
      'App crashed',
      'App stopped',
      'Claude is waiting',
      'Claude finished',
    ]);
  });

  it('Offline: same banner as Logs, and "Reconnected" once back', async () => {
    const t = await ready();
    await t.user.click(screen.getByRole('tab', { name: 'Activity' }));
    await goOffline(t);
    expect(screen.getByText(/Lost connection/)).toBeInTheDocument();
    t.client.status.mockResolvedValue(fakeDaemon().status);
    await act(() => new Promise((r) => setTimeout(r, 1100)));
    await t.connect();
    expect(await screen.findByText('Reconnected')).toBeInTheDocument();
    expect(screen.queryByText(/Lost connection/)).toBeNull();
  });
});

describe('Connection banner and whole page', () => {
  it('Focus: the banner is a status region and never takes focus', async () => {
    const t = await ready();
    screen.getByRole('tab', { name: 'Logs' }).focus();
    await goOffline(t);
    const banner = screen.getByText(/Lost connection/);
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner).not.toHaveAttribute('tabindex');
    expect(screen.getByRole('tab', { name: 'Logs' })).toHaveFocus();
  });

  it('Error: the retry count goes up while the daemon stays down', async () => {
    const t = await ready();
    await goOffline(t);
    await act(() => new Promise((r) => setTimeout(r, 600)));
    await t.drop();
    expect(
      await screen.findByText('Lost connection to FlutterDeck — retrying (2)…'),
    ).toBeInTheDocument();
  });

  it('Landmarks: header, main with a hidden h1, labelled tab panels and a footer', async () => {
    await ready();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'FlutterDeck' })).toBeInTheDocument();
    expect(screen.getByRole('tabpanel', { name: 'Logs' })).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });
});

describe('Project name', () => {
  it('Long content and Offline: truncated with the full name in title, still shown offline', async () => {
    const base = fakeDaemon();
    const name = `shop_${'x'.repeat(200)}`;
    const t = await ready(fakeDaemon({ status: { ...base.status, projectName: name } }));
    expect(screen.getByText(name)).toHaveAttribute('title', name);
    await goOffline(t);
    expect(screen.getByText(name)).toBeInTheDocument();
  });
});

describe('Live regions', () => {
  it('"App stopped — <name>" is announced in a status region once', async () => {
    const t = await ready();
    await t.send({ type: 'app.exit', payload: { appId: 'app-1', crashed: false } });
    const notice = screen.getByText('App stopped — com.example.shop');
    expect(notice).toHaveAttribute('role', 'status');
    await t.send({ type: 'heartbeat' });
    expect(screen.getAllByText('App stopped — com.example.shop')).toHaveLength(1);
  });

  it('the reload result sits in a polite status region', async () => {
    const t = await ready();
    await t.user.click(screen.getByRole('button', { name: 'Reload' }));
    const result = await screen.findByText('Reloaded in 182 ms');
    expect(result.closest('[role="status"]')).not.toBeNull();
  });
});
