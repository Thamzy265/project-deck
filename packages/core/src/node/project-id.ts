/**
 * The per-user registry `~/.flutterdeck/ports.json` (project path → port, plus a salt),
 * as clients read it. Only the daemon and `init` write it (daemon/src/port-registry.ts).
 */
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';

export const REGISTRY_DIR = '.flutterdeck';
export const REGISTRY_FILE = 'ports.json';

export const RegistrySchema = z.object({
  version: z.literal(1),
  salt: z.string().min(32),
  projects: z.record(z.string(), z.number().int().min(1).max(65535)),
});
export type PortRegistry = z.infer<typeof RegistrySchema>;

export function registryPath(homeDir: string): string {
  return join(homeDir, REGISTRY_DIR, REGISTRY_FILE);
}

/** First 12 hex characters of SHA-256(salt + project key): stable, and reveals no path. */
export function projectIdFor(salt: string, key: string): string {
  return createHash('sha256')
    .update(salt + key)
    .digest('hex')
    .slice(0, 12);
}

/** Symlinks resolved; case folded on Windows, whose paths are case-insensitive. */
export async function projectKey(projectDir: string): Promise<string> {
  let path = resolve(projectDir);
  try {
    path = await realpath(path);
  } catch {
    // A folder that doesn't exist yet keeps its resolved path.
  }
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

export type RegistryRead =
  | { state: 'ok'; registry: PortRegistry }
  | { state: 'missing' }
  | { state: 'damaged' }
  | { state: 'unreadable'; code: string };

/**
 * Reads the registry. A file that is empty or not valid yet may be one another process
 * is still writing (older versions wrote it in place), so it is read again for a moment
 * before it counts as damaged.
 */
export async function readRegistry(homeDir: string, waitMs = 200): Promise<RegistryRead> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    let text: string;
    try {
      text = await readFile(registryPath(homeDir), 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
      return code === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable', code };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = undefined;
    }
    const parsed = RegistrySchema.safeParse(raw);
    if (parsed.success) return { state: 'ok', registry: parsed.data };
    if (Date.now() >= deadline) return { state: 'damaged' };
    await sleep(20);
  }
}

/**
 * This project's id as its daemon shows it on /api/health, or undefined when the
 * registry doesn't exist or can't be read. Never creates or changes the registry.
 */
export async function readProjectIdentity(
  projectDir: string,
  opts: { homeDir?: string } = {},
): Promise<string | undefined> {
  const read = await readRegistry(opts.homeDir ?? homedir());
  if (read.state !== 'ok') return undefined;
  return projectIdFor(read.registry.salt, await projectKey(projectDir));
}
