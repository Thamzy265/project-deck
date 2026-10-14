/**
 * Log lines, app names and Claude's waiting messages are untrusted text (design note,
 * "Trust boundaries and abuse cases"). They must render as plain text: no element, link
 * or handler may come out of them.
 */
import type { LogEntry } from '@project-deck/core';
import { DEFAULT_LOG_CAPACITY } from '@project-deck/core';
import { fakeApp } from '@project-deck/core/testing';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fakeDaemon, renderDashboard } from '../testing/harness.js';

const HTML = '<img src=x onerror="window.__pwned=1"><b>bold</b>';
const SCRIPT = '<script>window.__pwned=1</script>';
const JS_URL = 'javascript:alert(document.cookie)';
const LINK = '<a href="javascript:alert(1)">click me</a>';
const BIDI = 'user ‮gnp.exe‬ done';
const ZERO_WIDTH = 'pass​word‍﻿';
const ANSI = '\u001b[31mred error\u001b[0m';

const entry = (message: string, extra: Partial<LogEntry> = {}): LogEntry => ({
  ts: 1_800_000_000_000,
  level: 'info',
  source: 'app',
  message,
  ...extra,
});

function logList(): HTMLElement {
  return screen.getByRole('list', { name: 'Log lines' });
}

function pwned(): unknown {
  return (window as unknown as { __pwned?: unknown }).__pwned;
}

describe('untrusted log text', () => {
  it('shows HTML, scripts and javascript: URLs as text, never as elements', async () => {
    const t = renderDashboard(
      fakeDaemon({
        logs: [HTML, SCRIPT, JS_URL, LINK].map((m) => entry(m)),
      }),
    );
    await t.connect();
    await screen.findByText(HTML);
    const list = logList();
    for (const text of [HTML, SCRIPT, JS_URL, LINK]) {
      expect(within(list).getByText(text)).toBeInTheDocument();
    }
    expect(list.querySelector('img, script, b, a, iframe, object, embed')).toBeNull();
    expect(document.querySelector('[onerror]')).toBeNull();
    expect(pwned()).toBeUndefined();
  });

  it('shows a tag and a stack trace with markup as text', async () => {
    const t = renderDashboard(
      fakeDaemon({
        logs: [entry('boom', { tag: '<i>tag</i>', stack: `${HTML}\n#1 main (file:///a.dart:3)` })],
      }),
    );
    await t.connect();
    const list = logList();
    await within(list).findByText(/#1 main/);
    expect(list.textContent).toContain(HTML);
    expect(list.querySelector('img, i')).toBeNull();
  });

  it('keeps bidi overrides, zero-width characters and ANSI escapes inside the message', async () => {
    const t = renderDashboard(
      fakeDaemon({ logs: [BIDI, ZERO_WIDTH, ANSI].map((m) => entry(m, { level: 'error' })) }),
    );
    await t.connect();
    const list = logList();
    for (const text of [BIDI, ZERO_WIDTH, ANSI]) {
      // The exact characters, in the message's own element, so an override can't run into
      // the time or level columns.
      const el = within(list).getByText(text, { normalizer: (s) => s });
      expect(el.textContent).toBe(text);
      const row = el.closest('[role="listitem"]');
      expect(row).not.toBeNull();
      expect(el).not.toBe(row);
    }
    // The level is still announced as text next to each line.
    expect(within(list).getAllByText('Error')).toHaveLength(3);
  });

  it('copy and "Show more" labels carry the text without making it markup', async () => {
    const long = `${SCRIPT}\n2\n3\n4\n5\n6`;
    const t = renderDashboard(fakeDaemon({ logs: [entry(long)] }));
    await t.connect();
    const more = await screen.findByRole('button', { name: /^Show more: .*<script>/ });
    expect(more).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Copy line: .*<script>/ })).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
  });

  it('renders a 1 MB line and searching it stays within the first 4 kB', async () => {
    const big = `${'x'.repeat(1024 * 1024 - 6)}NEEDLE`;
    const t = renderDashboard(fakeDaemon({ logs: [entry(big), entry('small line')] }));
    await t.connect();
    await screen.findByText('small line');
    const list = logList();
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    const user = userEvent.setup();
    await user.type(screen.getByRole('searchbox', { name: 'Search logs' }), 'NEEDLE');
    // The needle is past the 4 kB the search reads, so the line is not found.
    expect(await screen.findByText('Showing 0 of 2')).toBeInTheDocument();
  });

  it('keeps the list virtual through a burst of 10,000 lines', async () => {
    const t = renderDashboard();
    await t.connect();
    await act(async () => {
      for (let i = 0; i < 10_000; i++) {
        t.socket().onmessage?.({
          data: JSON.stringify({
            type: 'app.log',
            payload: { appId: 'app-1', entry: entry(`burst ${i}`, { ts: 1_800_000_000_000 + i }) },
          }),
        });
      }
      await Promise.resolve();
    });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Level' }), 'info');
    expect(await screen.findByText('Showing 10,000 of 10,000')).toBeInTheDocument();
    // Only the visible window (plus overscan) is in the DOM.
    expect(within(logList()).getAllByRole('listitem').length).toBeLessThan(100);
  });

  it(`keeps at most ${DEFAULT_LOG_CAPACITY.toLocaleString('en')} lines in the page`, async () => {
    const logs = Array.from({ length: DEFAULT_LOG_CAPACITY + 500 }, (_, i) =>
      entry(`line ${i}`, { ts: 1_800_000_000_000 + i }),
    );
    const t = renderDashboard();
    await t.connect();
    await act(async () => {
      for (const e of logs) {
        t.socket().onmessage?.({
          data: JSON.stringify({ type: 'app.log', payload: { appId: 'app-1', entry: e } }),
        });
      }
      await Promise.resolve();
    });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Level' }), 'info');
    const cap = DEFAULT_LOG_CAPACITY.toLocaleString('en');
    expect(await screen.findByText(`Showing ${cap} of ${cap}`)).toBeInTheDocument();
  });
});

describe('untrusted activity and app text', () => {
  it("shows Claude's waiting message with markup as text", async () => {
    const t = renderDashboard();
    await t.connect();
    await t.send({
      type: 'activity',
      payload: {
        id: 1,
        ts: 1_800_000_000_000,
        kind: 'claude.waiting',
        message: `${SCRIPT}${LINK}`,
      },
    });
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Activity' }));
    const feed = screen.getByRole('list', { name: 'Activity' });
    expect(within(feed).getByText(`Claude is waiting: ${SCRIPT}${LINK}`)).toBeInTheDocument();
    expect(feed.querySelector('script, a')).toBeNull();
  });

  it('collapses a long waiting message behind "Show more" (2 000 characters, the hook limit)', async () => {
    const t = renderDashboard();
    await t.connect();
    const message = `${BIDI} ${'w'.repeat(1990)}`.slice(0, 2000);
    await t.send({
      type: 'activity',
      payload: { id: 2, ts: 1_800_000_000_000, kind: 'claude.waiting', message },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Activity' }));
    const more = screen.getByRole('button', { name: /^Show more: Claude's message/ });
    await user.click(more);
    expect(screen.queryByRole('button', { name: /^Show more/ })).toBeNull();
    expect(screen.getByText(`Claude is waiting: ${message}`)).toBeInTheDocument();
  });

  it('shows an app name with markup as text in the picker and Activity', async () => {
    const evil = fakeApp({ name: `${HTML}${BIDI}` });
    const t = renderDashboard(
      fakeDaemon({
        status: { ...fakeDaemon().status, apps: [evil], attached: evil },
        activity: [{ id: 3, ts: 1, kind: 'app.attached', appId: evil.id, appName: evil.name }],
      }),
    );
    await t.connect();
    const picker = await screen.findByRole('combobox', { name: 'App' });
    expect(picker).toHaveAttribute('title', expect.stringContaining(HTML));
    expect(document.querySelector('header img, header b')).toBeNull();
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Activity' }));
    expect(screen.getByText(`Attached to ${evil.name}`)).toBeInTheDocument();
    expect(pwned()).toBeUndefined();
  });

  it('shows a failed reload message with markup as text in the result chip', async () => {
    const t = renderDashboard(
      fakeDaemon({
        reloadResult: { ok: false, reason: 'compile-error', message: `${HTML}\n${SCRIPT}` },
      }),
    );
    await t.connect();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));
    const errors = await screen.findByText(HTML);
    expect(errors.tagName).toBe('LI');
    expect(screen.getByText(SCRIPT).tagName).toBe('LI');
    expect(document.querySelector('header img, header script, header b')).toBeNull();
  });
});
