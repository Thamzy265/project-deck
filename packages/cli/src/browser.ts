/**
 * `flutterdeck open --browser`: shows the dashboard in the default browser. One fixed
 * program per system, by absolute path, with no shell: `/usr/bin/open` (macOS),
 * `xdg-open` from /usr/bin or /usr/local/bin (Linux), `%SystemRoot%\explorer.exe`
 * (Windows; `cmd /c start` would parse the URL as shell text). The URL must be exactly a
 * dashboard origin, so nothing else can reach those programs.
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { win32 } from 'node:path';

const DASHBOARD_URL = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/$/;

export function isDashboardUrl(url: string): boolean {
  const port = Number(DASHBOARD_URL.exec(url)?.[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export interface BrowserEnv {
  platform: NodeJS.Platform;
  exists: (path: string) => boolean;
  /** %SystemRoot% on Windows. */
  systemRoot?: string | undefined;
}

export function browserCommand(
  url: string,
  env: BrowserEnv,
): { command: string; args: string[] } | undefined {
  if (!isDashboardUrl(url)) return undefined;
  if (env.platform === 'darwin') return { command: '/usr/bin/open', args: [url] };
  if (env.platform === 'win32') {
    const root = env.systemRoot;
    if (root === undefined || !win32.isAbsolute(root)) return undefined;
    return { command: win32.join(root, 'explorer.exe'), args: [url] };
  }
  const command = ['/usr/bin/xdg-open', '/usr/local/bin/xdg-open'].find((p) => env.exists(p));
  return command === undefined ? undefined : { command, args: [url] };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Starts the browser and returns at once; false when there is no way to on this system. */
export function openBrowser(url: string): boolean {
  const found = browserCommand(url, {
    platform: process.platform,
    exists: isFile,
    systemRoot: process.env.SystemRoot,
  });
  if (found === undefined) return false;
  const child = spawn(found.command, found.args, {
    detached: true,
    stdio: 'ignore',
    shell: false,
    windowsHide: true,
  });
  // A failed start must not crash the CLI; the URL is printed anyway.
  child.on('error', () => undefined);
  child.unref();
  return true;
}
