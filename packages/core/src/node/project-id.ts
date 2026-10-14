/**
 * The per-user registry `~/.flutterdeck/ports.json` (project path → port, plus a salt),
 * as clients read it. Only the daemon and `init` write it (daemon/src/port-registry.ts).
 */
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
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

/**
 * This project's id as its daemon shows it on /api/health, or undefined when the
 * registry doesn't exist or can't be read. Never creates or changes the registry.
 */
export async function readProjectIdentity(
  projectDir: string,
  opts: { homeDir?: string } = {},
): Promise<string | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(registryPath(opts.homeDir ?? homedir()), 'utf8'));
  } catch {
    return undefined;
  }
  const parsed = RegistrySchema.safeParse(raw);
  if (!parsed.success) return undefined;
  return projectIdFor(parsed.data.salt, await projectKey(projectDir));
}
