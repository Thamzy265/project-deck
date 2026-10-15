/**
 * Tester edge cases for OS notifications: from a bus event through the Activity feed and
 * the rate limit to the exact command the system notifier would spawn. The spawn is a fake;
 * no notifier command ever runs.
 */
import { EventEmitter } from 'node:events';
import type { DeckEvents } from '@project-deck/core';
import { DEFAULT_CONFIG, EventBus } from '@project-deck/core';
import { fakeApp } from '@project-deck/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityFeed } from './activity.js';
import { NOTIFY_RATE_WINDOW_MS, startNotifications } from './notifications.js';
import { MAX_NOTIFY_TEXT, WINDOWS_SCRIPT } from './notify-command.js';
import type { NotifierChild, SpawnNotifier } from './notify-run.js';
import { NOTIFIER_TIMEOUT_MS, systemNotifier } from './notify-run.js';

class FakeChild extends EventEmitter implements NotifierChild {
  killed = 0;
  kill(): boolean {
    this.killed++;
    return true;
  }
}

interface Spawned {
  file: string;
  args: readonly string[];
  env: Record<string, string | undefined> | undefined;
  child: FakeChild;
}

function fakeSpawn() {
  const spawned: Spawned[] = [];
  const spawn: SpawnNotifier = (file, args, options) => {
    const child = new FakeChild();
    spawned.push({ file, args, env: options.env, child });
    return child;
  };
  return { spawn, spawned };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(platform: NodeJS.Platform, settings = { ...DEFAULT_CONFIG.notifications }) {
  const bus = new EventBus<DeckEvents>();
  const clock = { now: 1_000_000 };
  new ActivityFeed(bus, { now: () => clock.now }).start();
  const { spawn, spawned } = fakeSpawn();
  const logs: string[] = [];
  const notify = systemNotifier({
    platform,
    env: { SystemRoot: 'C:\\Windows', DECK_NOTIFY_TEXT: 'planted', PATH: 'C:\\evil' },
    spawn,
    findNotifySend: () => '/usr/bin/notify-send',
    log: (m) => logs.push(m),
  });
  const stop = startNotifications(bus, { settings, notify });
  const app = fakeApp({ name: 'shop_app' });
  bus.emit('app.attached', { app });
  return { bus, clock, spawned, logs, stop, app, settings };
}

afterEach(() => {
  vi.useRealTimers();
});

/** Text payloads a crafted waiting message or app name may hold. */
const PAYLOAD =
  '"; do shell script "id" --\n$(touch x) `y` </text><actions><action arguments="https://x"/></actions>\u202e\u0000';

describe('notifications end to end, with a fake spawn', () => {
  it('macOS: the waiting message reaches osascript only as one cleaned argument after --', async () => {
    const { bus, spawned } = setup('darwin');
    bus.emit('claude.waiting', { message: PAYLOAD });
    await flush();
    expect(spawned).toHaveLength(1);
    const [cmd] = spawned;
    expect(cmd?.file).toBe('/usr/bin/osascript');
    expect(cmd?.args.slice(0, 4)).toEqual(['-e', cmd?.args[1], '--', 'FlutterDeck']);
    expect(cmd?.args).toHaveLength(5);
    const text = cmd?.args[4] ?? '';
    expect(text.startsWith('Claude is waiting — "; do shell script')).toBe(true);
    expect(text).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(Array.from(text).length).toBeLessThanOrEqual(MAX_NOTIFY_TEXT);
    expect(cmd?.args[1]).not.toContain('shell script "id"');
  });

  it('Windows: the payload is only in the two environment variables, never in argv', async () => {
    const { bus, spawned, app } = setup('win32');
    bus.emit('claude.waiting', { message: PAYLOAD });
    bus.emit('app.exit', { appId: app.id, crashed: true });
    await flush();
    expect(spawned).toHaveLength(2);
    for (const cmd of spawned) {
      expect(cmd.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
      expect(Buffer.from(cmd.args[3] ?? '', 'base64').toString('utf16le')).toBe(WINDOWS_SCRIPT);
      for (const arg of cmd.args) {
        for (const piece of ['shell script', 'touch', '<actions>', 'shop_app', 'waiting']) {
          expect(arg).not.toContain(piece);
        }
      }
      expect(cmd.env?.DECK_NOTIFY_TITLE).toBe('FlutterDeck');
    }
    expect(spawned[0]?.env?.DECK_NOTIFY_TEXT).toContain('</text><actions>');
    // A DECK_NOTIFY_TEXT already in the daemon's environment never wins.
    expect(spawned[1]?.env?.DECK_NOTIFY_TEXT).toBe('App crashed — shop_app');
  });

  it('Linux: markup is escaped and the text comes after --', async () => {
    const { bus, spawned } = setup('linux');
    bus.emit('claude.waiting', { message: '<b>Allow</b> & go' });
    await flush();
    expect(spawned[0]?.args).toEqual([
      '--',
      'FlutterDeck',
      'Claude is waiting — &lt;b&gt;Allow&lt;/b&gt; &amp; go',
    ]);
  });

  it('cleans an app name that holds control characters and markup (it comes from the VM)', async () => {
    const { bus, spawned } = setup('darwin');
    const app = fakeApp({ id: 'evil', name: 'shop\n-e\u202e<app>' });
    bus.emit('app.attached', { app });
    bus.emit('app.exit', { appId: app.id, crashed: true });
    await flush();
    expect(spawned[0]?.args[4]).toBe('App crashed — shop -e<app>');
  });

  it('sends each kind on its own clock: a crash, a failed reload and a wait at once', async () => {
    const { bus, spawned, app } = setup('darwin');
    bus.emit('claude.reload', { ok: false, kind: 'hot-reload' });
    bus.emit('claude.waiting', { message: 'Allow?' });
    bus.emit('app.exit', { appId: app.id, crashed: true });
    await flush();
    expect(spawned.map((s) => s.args[4])).toEqual([
      'Reload failed — shop_app',
      'Claude is waiting — Allow?',
      'App crashed — shop_app',
    ]);
  });

  it('counts a failed VM reload and a failed Claude reload in the same window', async () => {
    const { bus, spawned, clock, app } = setup('darwin');
    bus.emit('app.reloaded', {
      appId: app.id,
      result: { ok: false, reason: 'compile-error', message: 'x' },
    });
    bus.emit('claude.reload', { ok: false, kind: 'hot-restart' });
    clock.now += NOTIFY_RATE_WINDOW_MS;
    bus.emit('claude.reload', { ok: false, kind: 'hot-reload' });
    await flush();
    expect(spawned.map((s) => s.args[4])).toEqual([
      'Reload failed — shop_app',
      'Reload failed (2 times) — shop_app',
    ]);
  });

  it('never counts events while a switch is off', async () => {
    const { bus, spawned, clock, settings } = setup('darwin');
    bus.emit('claude.waiting', { message: 'one' });
    await flush();
    settings.claudeWaiting = false;
    bus.emit('claude.waiting', { message: 'two' });
    bus.emit('claude.waiting', { message: 'three' });
    // Activity entries reach the notifier a microtask later; switch back after that.
    await flush();
    settings.claudeWaiting = true;
    clock.now += NOTIFY_RATE_WINDOW_MS;
    bus.emit('claude.waiting', { message: 'four' });
    await flush();
    expect(spawned.map((s) => s.args[4])).toEqual([
      'Claude is waiting — one',
      'Claude is waiting — four',
    ]);
  });

  it('runs nothing at all when every switch is off', async () => {
    const { bus, spawned, app } = setup('darwin', {
      appCrashed: false,
      reloadFailed: false,
      claudeWaiting: false,
    });
    bus.emit('claude.waiting', { message: 'x' });
    bus.emit('claude.reload', { ok: false, kind: 'hot-reload' });
    bus.emit('app.exit', { appId: app.id, crashed: true });
    await flush();
    expect(spawned).toEqual([]);
  });

  it('never notifies for a stop, a detach, a successful reload or Claude finishing', async () => {
    const { bus, spawned, app } = setup('darwin');
    bus.emit('claude.reload', { ok: true, kind: 'hot-restart' });
    bus.emit('app.reloaded', { appId: app.id, result: { ok: true, kind: 'hot-reload' } });
    bus.emit('claude.done', {});
    bus.emit('app.detached', { appId: app.id });
    bus.emit('app.exit', { appId: app.id, crashed: false });
    await flush();
    expect(spawned).toEqual([]);
  });

  it('a hanging notifier is killed after 5 s and never holds up the next one', async () => {
    vi.useFakeTimers();
    const { bus, spawned, logs, app } = setup('darwin');
    bus.emit('claude.waiting', { message: 'one' });
    await vi.advanceTimersByTimeAsync(0);
    bus.emit('app.exit', { appId: app.id, crashed: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(spawned).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(NOTIFIER_TIMEOUT_MS);
    expect(spawned.map((s) => s.child.killed)).toEqual([1, 1]);
    expect(logs).toEqual(["Couldn't show an OS notification (osascript: timeout)"]);
    // A late exit after the kill is ignored.
    spawned[0]?.child.emit('exit', null, 'SIGKILL');
    expect(logs).toHaveLength(1);
  });

  it('says "Claude is waiting" alone for a blank message', async () => {
    const { bus, spawned } = setup('darwin');
    bus.emit('claude.waiting', { message: '  \n\t ' });
    await flush();
    expect(spawned[0]?.args[4]).toBe('Claude is waiting');
  });

  // T-P5-8: a message of only control or invisible characters survives the trim in
  // notifications.ts, so the text ends in a dangling " —" once the notifier cleans it.
  it.fails(
    'T-P5-8 says "Claude is waiting" alone for a message of invisible characters',
    async () => {
      const { bus, spawned } = setup('darwin');
      bus.emit('claude.waiting', { message: '\u202e\u0007\u200b' });
      await flush();
      expect(spawned[0]?.args[4]).toBe('Claude is waiting');
    },
  );
});
