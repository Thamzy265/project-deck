/**
 * The page through connection trouble (design note, "Failure plan" and "Session expiry"):
 * drops during the first load, a daemon restart during a reload, bad messages, and
 * browser storage that throws.
 */
import type { LogsResult, ReloadResult } from '@project-deck/core';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { NetworkError } from '../api/client.js';
import { app2, fakeDaemon, MemoryStorage, renderDashboard } from '../testing/harness.js';

const log = (ts: number, message: string) => ({
  ts,
  level: 'info' as const,
  source: 'app' as const,
  message,
});

const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

function rows(): string[] {
  return within(screen.getByRole('list', { name: 'Log lines' }))
    .getAllByRole('listitem')
    .map((r) => r.textContent);
}

class ThrowingStorage extends MemoryStorage {
  constructor(private readonly on: 'all' | 'set') {
    super();
  }
  override getItem(key: string): string | null {
    if (this.on === 'all') throw new DOMException('The operation is insecure.', 'SecurityError');
    return super.getItem(key);
  }
  override setItem(): void {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  }
}

describe('drops during the first load', () => {
  it('keeps the lines that arrive after the socket closed, then fills the gap once', async () => {
    let answer: (r: LogsResult) => void = () => undefined;
    const t = renderDashboard(fakeDaemon({ logs: [log(1, 'one'), log(2, 'two')] }));
    t.client.logs.mockReturnValueOnce(new Promise((r) => (answer = r)));
    await t.connect();
    await t.drop();
    expect(await screen.findByText(/Lost connection/)).toBeInTheDocument();
    await act(async () => {
      answer({ entries: [log(1, 'one')], truncated: false });
      await Promise.resolve();
    });
    expect(await screen.findByText('one')).toBeInTheDocument();
    // Reconnect: the backfill has both lines; "one" must not appear twice.
    await wait(600);
    await t.connect();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows()).toEqual([expect.stringContaining('one'), expect.stringContaining('two')]);
    expect(t.client.logs).toHaveBeenLastCalledWith(500);
  });

  it('shows the dashboard with the retry banner when the socket never opens but status answers', async () => {
    const t = renderDashboard();
    await t.drop();
    expect(await screen.findByText('shop_app')).toBeInTheDocument();
    expect(screen.getByText(/Lost connection to FlutterDeck — retrying \(1\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toHaveAttribute(
      'title',
      'Not connected',
    );
  });
});

describe('a daemon restart while a reload is in flight', () => {
  it('frees the buttons when the reload call fails, and shows the reason once back', async () => {
    let fail: (err: Error) => void = () => undefined;
    const t = renderDashboard();
    await t.connect();
    await screen.findByText('shop_app');
    t.client.reload.mockReturnValueOnce(new Promise<ReloadResult>((_, reject) => (fail = reject)));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(screen.getByRole('button', { name: 'Reloading…' })).toBeInTheDocument();

    t.client.status.mockRejectedValueOnce(new NetworkError('Failed to fetch'));
    await t.drop();
    await act(async () => {
      fail(new NetworkError('Failed to fetch'));
      await Promise.resolve();
    });
    // Offline: the buttons say why they can't be used, not "Reloading…".
    expect(screen.getByRole('button', { name: 'Reload' })).toHaveAttribute(
      'title',
      'Not connected',
    );

    await wait(600);
    await t.connect();
    expect(
      await screen.findByRole('button', { name: 'Last reload: failed, 1 error' }),
    ).toBeVisible();
    expect(screen.getByText('Failed to fetch')).toBeInTheDocument();
    const reload = screen.getByRole('button', { name: 'Reload' });
    expect(reload).not.toHaveAttribute('aria-disabled');
    await user.click(reload);
    expect(t.client.reload).toHaveBeenCalledTimes(2);
  });

  it('a late success from before the restart still counts', async () => {
    let succeed: (r: ReloadResult) => void = () => undefined;
    const t = renderDashboard();
    await t.connect();
    await screen.findByText('shop_app');
    t.client.reload.mockReturnValueOnce(new Promise<ReloadResult>((r) => (succeed = r)));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));
    t.client.status.mockRejectedValueOnce(new NetworkError('Failed to fetch'));
    await t.drop();
    await wait(600);
    await t.connect();
    await act(async () => {
      succeed({ ok: true, kind: 'hot-reload', durationMs: 40 });
      await Promise.resolve();
    });
    expect(await screen.findByText('Reloaded in 40 ms')).toBeInTheDocument();
  });

  it('a 401 after the restart reloads the page while the reload call is still open', async () => {
    const { HttpError } = await import('../api/client.js');
    const t = renderDashboard();
    await t.connect();
    await screen.findByText('shop_app');
    t.client.reload.mockReturnValueOnce(new Promise<ReloadResult>(() => undefined));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));
    t.client.status.mockRejectedValue(new HttpError(401, 'Missing or invalid token'));
    await t.drop();
    await waitFor(() => expect(t.reloadPage).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Reconnecting to FlutterDeck…')).toBeInTheDocument();
  });
});

describe('messages', () => {
  it('ignores messages that fail validation and keeps working', async () => {
    const t = renderDashboard();
    await t.connect();
    await screen.findByText('shop_app');
    await act(async () => {
      for (const data of [
        '{"type":"app.log","payload":{"appId":"app-1","entry":{"message":"<b>no ts</b>"}}}',
        '{"type":"app.attached","payload":{"app":{"id":"x"}}}',
        '{"type":"activity","payload":{"id":-1,"ts":1,"kind":"claude.done"}}',
        '{"type":"unknown.kind","payload":{}}',
        '{not json',
      ]) {
        t.socket().onmessage?.({ data });
      }
      await Promise.resolve();
    });
    await t.send({ type: 'app.log', payload: { appId: 'app-1', entry: log(5, 'valid') } });
    expect(await screen.findByText('valid')).toBeInTheDocument();
    expect(screen.queryByText('<b>no ts</b>')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'App' })).toHaveDisplayValue(
      'com.example.shop · Pixel 9 API 36 · IDE',
    );
  });

  it('keeps log lines that arrive before hello, and hello sets the apps', async () => {
    const t = renderDashboard();
    await t.connect();
    await screen.findByText('shop_app');
    await t.send({ type: 'app.log', payload: { appId: 'app-1', entry: log(3, 'early') } });
    await t.send({
      type: 'hello',
      payload: { apps: [app2], attached: app2, discovering: false },
    });
    expect(await screen.findByText('early')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'App' })).toHaveDisplayValue(
      'com.example.admin · Pixel 9 API 36 · terminal',
    );
  });

  it('a hello saying discovery runs again shows "Finding apps…" when no app is left', async () => {
    const base = fakeDaemon();
    const t = renderDashboard(fakeDaemon({ status: { ...base.status, apps: [], attached: null } }));
    await t.connect();
    expect(await screen.findByText('No app running')).toBeInTheDocument();
    await t.send({ type: 'hello', payload: { apps: [], attached: null, discovering: true } });
    expect(screen.getByText('Finding apps…')).toBeInTheDocument();
    await t.send({ type: 'apps.discovering', payload: { discovering: false } });
    expect(screen.getByText('No app running')).toBeInTheDocument();
  });
});

describe('browser storage', () => {
  it('works with localStorage throwing: shortcuts on, the switch still works for this page', async () => {
    const prefs = new ThrowingStorage('all');
    const t = renderDashboard(fakeDaemon(), prefs);
    await t.connect();
    await screen.findByText('shop_app');
    const user = userEvent.setup();
    await user.keyboard('r');
    await waitFor(() => expect(t.client.reload).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'More log options' }));
    await user.click(screen.getByRole('switch', { name: 'Keyboard shortcuts r / R: on' }));
    expect(screen.getByRole('switch')).toHaveAccessibleName('Keyboard shortcuts r / R: off');
    screen.getByRole('tab', { name: 'Logs' }).focus();
    await user.keyboard('r');
    expect(t.client.reload).toHaveBeenCalledTimes(1);
  });

  it('works with localStorage full: the switch turns off without an error', async () => {
    const prefs = new ThrowingStorage('set');
    const t = renderDashboard(fakeDaemon(), prefs);
    await t.connect();
    await screen.findByText('shop_app');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'More log options' }));
    await user.click(screen.getByRole('switch'));
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });
});
