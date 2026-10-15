import { spawn as nodeSpawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import type { NotifierCommand } from './notify-command.js';
import { LINUX_NOTIFY_SEND_PATHS, notifierCommand } from './notify-command.js';

export const NOTIFIER_TIMEOUT_MS = 5000;

/** Shows one OS notification; never throws. */
export type Notifier = (title: string, text: string) => void;

export interface NotifierChild {
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnNotifier = (
  file: string,
  args: readonly string[],
  options: {
    shell: false;
    windowsHide: true;
    stdio: 'ignore';
    env?: Record<string, string | undefined>;
  },
) => NotifierChild;

export interface RunNotifierOptions {
  spawn: SpawnNotifier;
  /** Called at most once with a short reason (an error code, `exit 1`, `timeout`). */
  onFailure: (reason: string) => void;
  timeoutMs?: number;
}

const codeOf = (err: unknown) =>
  (err as NodeJS.ErrnoException | undefined)?.code ?? (err instanceof Error ? err.name : 'error');

/** Runs one notifier command; resolves when it ends, fails or is killed after the timeout. */
export function runNotifier(cmd: NotifierCommand, opts: RunNotifierOptions): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (failure?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failure !== undefined) opts.onFailure(failure);
      resolve();
    };
    let child: NotifierChild;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish('timeout');
    }, opts.timeoutMs ?? NOTIFIER_TIMEOUT_MS);
    try {
      child = opts.spawn(cmd.file, cmd.args, {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
        ...(cmd.env === undefined ? {} : { env: cmd.env }),
      });
    } catch (err) {
      finish(codeOf(err));
      return;
    }
    child.on('error', (err) => finish(codeOf(err)));
    child.on('exit', (code, signal) => {
      if (code === 0) finish();
      else finish(code === null ? `signal ${signal ?? 'unknown'}` : `exit ${code}`);
    });
  });
}

/** `osascript`, `notify-send` or `powershell`, from a POSIX or Windows path. */
const programName = (file: string) => (file.split(/[\\/]/).pop() ?? file).replace(/\.exe$/i, '');

function findNotifySend(): string | undefined {
  for (const path of LINUX_NOTIFY_SEND_PATHS) {
    try {
      if (!statSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // Not there or not runnable; try the next fixed path.
    }
  }
  return undefined;
}

export interface SystemNotifierOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  spawn?: SpawnNotifier;
  findNotifySend?: () => string | undefined;
  /** Never gets the title or text: they may hold Claude's message. */
  log: (message: string) => void;
}

/** The notifier for this OS. Failures are logged once, without the text, and never retried. */
export function systemNotifier(opts: SystemNotifierOptions): Notifier {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const spawn = opts.spawn ?? nodeSpawn;
  let notifySend: { path: string | undefined } | undefined;
  const deps = {
    env,
    findNotifySend: () => {
      notifySend ??= { path: (opts.findNotifySend ?? findNotifySend)() };
      if (notifySend.path === undefined && !missingNoted) {
        missingNoted = true;
        opts.log('notify-send not found in /usr/bin or /usr/local/bin; OS notifications are off');
      }
      return notifySend.path;
    },
  };
  let missingNoted = false;
  let failureLogged = false;
  return (title, text) => {
    const cmd = notifierCommand(platform, title, text, deps);
    if (cmd === undefined) return;
    void runNotifier(cmd, {
      spawn,
      onFailure: (reason) => {
        if (failureLogged) return;
        failureLogged = true;
        opts.log(`Couldn't show an OS notification (${programName(cmd.file)}: ${reason})`);
      },
    });
  };
}
