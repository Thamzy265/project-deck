import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NotifierChild, SpawnNotifier } from './notify-run.js';
import { NOTIFIER_TIMEOUT_MS, runNotifier, systemNotifier } from './notify-run.js';

class FakeChild extends EventEmitter implements NotifierChild {
  killed: (NodeJS.Signals | number | undefined)[] = [];
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed.push(signal);
    return true;
  }
}

function fakeSpawn() {
  const children: FakeChild[] = [];
  const calls: { file: string; args: readonly string[]; options: unknown }[] = [];
  const spawn: SpawnNotifier = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  return { spawn, children, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('runNotifier', () => {
  const cmd = { file: '/usr/bin/osascript', args: ['-e', 'x', '--', 't', 'b'] };

  it('spawns the absolute path without a shell, hidden, with no stdio', async () => {
    const { spawn, children, calls } = fakeSpawn();
    const done = runNotifier(cmd, { spawn, onFailure: vi.fn() });
    children[0]?.emit('exit', 0, null);
    await done;
    expect(calls).toEqual([
      {
        file: '/usr/bin/osascript',
        args: ['-e', 'x', '--', 't', 'b'],
        options: { shell: false, windowsHide: true, stdio: 'ignore' },
      },
    ]);
  });

  it('passes a Windows command its own environment', async () => {
    const { spawn, children, calls } = fakeSpawn();
    const done = runNotifier(
      { file: 'C:\\p.exe', args: [], env: { DECK_NOTIFY_TEXT: 'x' } },
      { spawn, onFailure: vi.fn() },
    );
    children[0]?.emit('exit', 0, null);
    await done;
    expect(calls[0]?.options).toMatchObject({ env: { DECK_NOTIFY_TEXT: 'x' } });
  });

  it("reports a spawn 'error' event (missing binary) and never throws", async () => {
    const { spawn, children } = fakeSpawn();
    const onFailure = vi.fn();
    const done = runNotifier(cmd, { spawn, onFailure });
    children[0]?.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    await done;
    expect(onFailure).toHaveBeenCalledWith('ENOENT');
  });

  it('reports a non-zero exit by its code', async () => {
    const { spawn, children } = fakeSpawn();
    const onFailure = vi.fn();
    const done = runNotifier(cmd, { spawn, onFailure });
    children[0]?.emit('exit', 1, null);
    await done;
    expect(onFailure).toHaveBeenCalledWith('exit 1');
  });

  it('reports a spawn that throws at once', async () => {
    const onFailure = vi.fn();
    await runNotifier(cmd, {
      spawn: () => {
        throw Object.assign(new Error('bad'), { code: 'EINVAL' });
      },
      onFailure,
    });
    expect(onFailure).toHaveBeenCalledWith('EINVAL');
  });

  it('kills a notifier that hangs after 5 s', async () => {
    vi.useFakeTimers();
    const { spawn, children } = fakeSpawn();
    const onFailure = vi.fn();
    const done = runNotifier(cmd, { spawn, onFailure });
    await vi.advanceTimersByTimeAsync(NOTIFIER_TIMEOUT_MS - 1);
    expect(children[0]?.killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(children[0]?.killed).toEqual(['SIGKILL']);
    await done;
    expect(onFailure).toHaveBeenCalledWith('timeout');
    // The exit that follows the kill isn't a second failure.
    children[0]?.emit('exit', null, 'SIGKILL');
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('reports once when both error and exit arrive', async () => {
    const { spawn, children } = fakeSpawn();
    const onFailure = vi.fn();
    const done = runNotifier(cmd, { spawn, onFailure });
    children[0]?.emit('error', new Error('x'));
    children[0]?.emit('exit', 1, null);
    await done;
    expect(onFailure).toHaveBeenCalledTimes(1);
  });
});

describe('systemNotifier', () => {
  it('runs the platform command and logs the first failure only, without the text', async () => {
    const { spawn, children, calls } = fakeSpawn();
    const log = vi.fn();
    const notify = systemNotifier({ platform: 'darwin', env: {}, spawn, log });
    notify('FlutterDeck', 'Claude is waiting — secret text');
    notify('FlutterDeck', 'again');
    for (const child of children) child.emit('exit', 1, null);
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    expect(calls.map((c) => c.file)).toEqual(['/usr/bin/osascript', '/usr/bin/osascript']);
    const logged = String(log.mock.calls[0]?.[0]);
    expect(logged).toBe("Couldn't show an OS notification (osascript: exit 1)");
    expect(logged).not.toContain('secret');
  });

  it('notes once that notify-send is missing on Linux, and runs nothing', () => {
    const { spawn, calls } = fakeSpawn();
    const log = vi.fn();
    const notify = systemNotifier({
      platform: 'linux',
      env: {},
      spawn,
      log,
      findNotifySend: () => undefined,
    });
    notify('FlutterDeck', 'a');
    notify('FlutterDeck', 'b');
    expect(calls).toEqual([]);
    expect(log.mock.calls).toEqual([
      ['notify-send not found in /usr/bin or /usr/local/bin; OS notifications are off'],
    ]);
  });

  it('looks for notify-send once', () => {
    const { spawn, calls } = fakeSpawn();
    const findNotifySend = vi.fn(() => '/usr/local/bin/notify-send');
    const notify = systemNotifier({
      platform: 'linux',
      env: {},
      spawn,
      log: vi.fn(),
      findNotifySend,
    });
    notify('FlutterDeck', 'a');
    notify('FlutterDeck', 'b');
    expect(findNotifySend).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.file)).toEqual([
      '/usr/local/bin/notify-send',
      '/usr/local/bin/notify-send',
    ]);
  });
});
