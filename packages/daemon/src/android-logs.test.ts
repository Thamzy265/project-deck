import type { DeckEvents, LogEntry } from '@project-deck/core';
import { EventBus, Registry } from '@project-deck/core';
import { FakeAppConnector, fakeApp } from '@project-deck/core/testing';
import { AndroidLogFeed } from '@project-deck/logs-android';
import { FakeAdb, FIXTURE_PID, THREADTIME_FIXTURE } from '@project-deck/logs-android/testing';
import { describe, expect, it, vi } from 'vitest';
import { AppManager } from './app-manager.js';

const androidApp = fakeApp({
  pid: FIXTURE_PID,
  device: { id: 'unknown', name: 'Android device', platform: 'android' },
});

function setup(adb: FakeAdb) {
  const registry = new Registry();
  registry.connectors.register(new FakeAppConnector('fake', [androidApp]));
  registry.logFeeds.register(new AndroidLogFeed({ adb, flushAfterMs: 5 }));
  const bus = new EventBus<DeckEvents>();
  const logged: LogEntry[] = [];
  bus.onAny((type, payload) => {
    if (type === 'app.log') logged.push((payload as DeckEvents['app.log']).entry);
  });
  const manager = new AppManager(registry, bus);
  return { manager, logged };
}

describe('AppManager with the Android logcat feed', () => {
  it('merges native entries into the buffer and the bus, without flutter lines', async () => {
    const adb = new FakeAdb();
    const { manager, logged } = setup(adb);
    await manager.start();
    await vi.waitFor(() => expect(adb.streams).toHaveLength(1));
    adb.streams[0]?.emit(THREADTIME_FIXTURE);
    await vi.waitFor(() => expect(logged).toHaveLength(9));
    expect(logged.every((e) => e.source === 'native')).toBe(true);
    const buffered = (await manager.logs()?.query({ limit: 100 })) ?? [];
    expect(buffered.filter((e) => e.source === 'native')).toHaveLength(9);
    await manager.stop();
    expect(adb.streams[0]?.killed).toBe(true);
  });

  it('kills logcat on detach even when detach arrives during the device lookup', async () => {
    const adb = new FakeAdb();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const exec = adb.exec.bind(adb);
    const execSpy = vi.spyOn(adb, 'exec').mockImplementation(async (args) => {
      if (args[0] === 'devices') await gate;
      return exec(args);
    });
    const { manager, logged } = setup(adb);
    await manager.start();
    await vi.waitFor(() => expect(execSpy).toHaveBeenCalled());
    const detached = manager.detach();
    release();
    await detached;
    expect(adb.streams).toHaveLength(1);
    expect(adb.streams[0]?.killed).toBe(true);
    adb.streams[0]?.emit(THREADTIME_FIXTURE);
    await new Promise((r) => setTimeout(r, 20));
    expect(logged).toEqual([]);
    await manager.stop();
  });

  it('starts a fresh logcat on re-attach and stops the old one', async () => {
    const adb = new FakeAdb();
    const { manager } = setup(adb);
    await manager.start();
    await vi.waitFor(() => expect(adb.streams).toHaveLength(1));
    await manager.detach();
    await manager.attach(androidApp.id);
    expect(adb.streams.map((s) => s.killed)).toEqual([true, false]);
    await manager.stop();
    expect(adb.streams.map((s) => s.killed)).toEqual([true, true]);
  });
});
