import type { ActivityEntry, LogLevel, ReloadResult, RunningApp } from '@project-deck/core';
import type { LastResult } from '../state/deck.js';

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `short` mm:ss (320 px), `medium` HH:mm:ss, `full` with milliseconds (≥ 768 px). */
export function clock(ts: number, style: 'short' | 'medium' | 'full' | 'minutes'): string {
  const d = new Date(ts);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (style === 'minutes') return hm;
  if (style === 'short') return `${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const hms = `${hm}:${pad(d.getSeconds())}`;
  return style === 'medium' ? hms : `${hms}.${pad(d.getMilliseconds(), 3)}`;
}

const STARTED_BY: Record<RunningApp['startedBy'], string | undefined> = {
  ide: 'IDE',
  terminal: 'terminal',
  mcp: 'Claude',
  unknown: undefined,
};

export function appLabel(app: RunningApp): string {
  return [app.name, app.device?.name, STARTED_BY[app.startedBy]]
    .filter((part) => part !== undefined)
    .join(' · ');
}

export const LEVEL_NAME: Record<LogLevel, string> = {
  verbose: 'Verbose',
  debug: 'Debug',
  info: 'Info',
  warn: 'Warning',
  error: 'Error',
  fatal: 'Fatal',
};

export const LEVEL_LETTER: Record<LogLevel, string> = {
  verbose: 'V',
  debug: 'D',
  info: 'I',
  warn: 'W',
  error: 'E',
  fatal: 'F',
};

function done(kind: 'reload' | 'restart', external: boolean, durationMs?: number): string {
  const verb = kind === 'reload' ? 'Reloaded' : 'Restarted';
  if (external) return `${verb} (from Claude or the IDE)`;
  return durationMs === undefined ? verb : `${verb} in ${Math.round(durationMs)} ms`;
}

export function resultText(r: LastResult): string {
  if (!r.ok) return r.kind === 'reload' ? 'Reload failed' : 'Restart failed';
  return done(r.kind, r.external, r.durationMs);
}

function reloadText(result: ReloadResult): string {
  if (!result.ok) return 'Reload failed';
  const kind = result.kind === 'hot-restart' ? 'restart' : 'reload';
  return done(kind, result.source === 'external', result.durationMs);
}

export function activityText(entry: ActivityEntry): string {
  switch (entry.kind) {
    case 'claude.done':
      return 'Claude finished';
    case 'claude.waiting':
      return entry.message === undefined
        ? 'Claude is waiting'
        : `Claude is waiting: ${entry.message}`;
    case 'app.attached':
      return `Attached to ${entry.appName}`;
    case 'app.detached':
      return `Detached from ${entry.appName}`;
    case 'app.stopped':
      return 'App stopped';
    case 'app.crashed':
      return 'App crashed';
    case 'app.reloaded':
      return reloadText(entry.result);
    case 'claude.reload': {
      const kind = entry.reload === 'hot-restart' ? 'restart' : 'reload';
      if (entry.ok) return done(kind, true);
      const failed = kind === 'reload' ? 'Reload failed' : 'Restart failed';
      return entry.message === undefined ? failed : `${failed}: ${entry.message}`;
    }
    case 'db.snapshot':
      return `Snapshot taken: ${entry.db}`;
    case 'db.diff':
      return `Diff shown: ${entry.db}`;
    case 'db.write': {
      const tables = entry.tables.join(', ');
      if (!entry.allowed) return `Write denied: ${tables}`;
      const n = entry.changes ?? 0;
      return `Write allowed: ${tables}, ${n} ${n === 1 ? 'row' : 'rows'} changed`;
    }
  }
}
