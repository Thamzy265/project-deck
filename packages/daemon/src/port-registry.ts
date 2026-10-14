/**
 * Per-user registry `~/.flutterdeck/ports.json`: project path → dashboard port, plus a
 * random salt for project ids. It lets `init` give every project its own port even
 * while no daemon runs, and lets the daemon spot a committed config port that another
 * project on this machine already uses.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { acquireFileLock } from './startup-lock.js';

export const REGISTRY_DIR = '.flutterdeck';
export const REGISTRY_FILE = 'ports.json';
/** Where `init` starts looking. Not 9100: Dart DevTools listens there. */
export const FIRST_PORT = 9147;
const LOCK_FILE = 'ports.json.lock';
/** Updates take milliseconds; a lock this old was left by a crash. */
const LOCK_STALE_MS = 5000;

const RegistrySchema = z.object({
  version: z.literal(1),
  salt: z.string().min(32),
  projects: z.record(z.string(), z.number().int().min(1).max(65535)),
});
type PortRegistry = z.infer<typeof RegistrySchema>;

export interface PortRegistryOptions {
  /** The user's home folder; tests pass a temporary one. */
  homeDir?: string;
}

export interface AllocateOptions extends PortRegistryOptions {
  /** Whether nothing listens on the port right now. */
  isFree?: (port: number) => Promise<boolean>;
}

export class PortRegistryError extends Error {}

/**
 * Runs a read-modify-write of the registry under a cross-process lock, so two projects
 * that run `init` (or start a daemon) at the same moment can't both take one port.
 */
async function withRegistryLock<T>(homeDir: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireFileLock(
    join(homeDir, REGISTRY_DIR),
    LOCK_FILE,
    { staleMs: LOCK_STALE_MS, retryMs: 20 },
    () =>
      new PortRegistryError(
        `${registryPath(homeDir)} is locked by another FlutterDeck; try again.`,
      ),
  );
  try {
    return await fn();
  } finally {
    await release();
  }
}

export function registryPath(homeDir: string): string {
  return join(homeDir, REGISTRY_DIR, REGISTRY_FILE);
}

/** First 12 hex characters of SHA-256(salt + project path): stable, and reveals no path. */
export async function projectIdentity(
  projectDir: string,
  opts: PortRegistryOptions = {},
): Promise<string> {
  const registry = await load(home(opts));
  return idFor(registry.salt, await projectKey(projectDir));
}

/** The project's registered port, or the first free unregistered one from 9147, recorded. */
export async function allocatePort(
  projectDir: string,
  opts: AllocateOptions = {},
): Promise<number> {
  const homeDir = home(opts);
  return withRegistryLock(homeDir, () => allocateLocked(projectDir, homeDir, opts));
}

async function allocateLocked(
  projectDir: string,
  homeDir: string,
  opts: AllocateOptions,
): Promise<number> {
  const isFree = opts.isFree ?? canListen;
  const registry = await load(homeDir);
  const key = await projectKey(projectDir);
  const pruned = await pruneGone(registry, key);
  const existing = registry.projects[key];
  if (existing !== undefined) {
    if (pruned) await save(homeDir, registry);
    return existing;
  }
  const taken = new Set(Object.values(registry.projects));
  for (let port = FIRST_PORT; port <= 65535; port++) {
    if (taken.has(port) || !(await isFree(port))) continue;
    registry.projects[key] = port;
    await save(homeDir, registry);
    return port;
  }
  throw new PortRegistryError(`No free port from ${FIRST_PORT} upwards`);
}

/**
 * Checked at daemon start for a config port. Returns the id of another existing project
 * registered to the same port (a second clone or worktree with the same committed
 * config), whose registration is left alone; the caller warns and starts anyway, and
 * the port-busy check decides if both run at once. Otherwise records the port for this
 * project, so `init` won't hand it out elsewhere, and returns undefined.
 */
export async function claimConfigPort(
  projectDir: string,
  port: number,
  opts: PortRegistryOptions = {},
): Promise<string | undefined> {
  const homeDir = home(opts);
  return withRegistryLock(homeDir, () => claimLocked(projectDir, port, homeDir));
}

async function claimLocked(
  projectDir: string,
  port: number,
  homeDir: string,
): Promise<string | undefined> {
  const registry = await load(homeDir);
  const key = await projectKey(projectDir);
  const pruned = await pruneGone(registry, key);
  for (const [other, otherPort] of Object.entries(registry.projects)) {
    if (other !== key && otherPort === port) {
      if (pruned) await save(homeDir, registry);
      return idFor(registry.salt, other);
    }
  }
  // The config is the source of truth for this project's port, also after a manual edit.
  if (registry.projects[key] !== port || pruned) {
    registry.projects[key] = port;
    await save(homeDir, registry);
  }
  return undefined;
}

/**
 * Drops entries whose project folder no longer exists (moved, renamed or deleted), so
 * their ports become free again. Other errors, such as no permission, keep the entry.
 * Returns whether anything was dropped.
 */
async function pruneGone(registry: PortRegistry, keep: string): Promise<boolean> {
  let pruned = false;
  for (const path of Object.keys(registry.projects)) {
    if (path === keep) continue;
    try {
      await stat(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a record keyed by path
        delete registry.projects[path];
        pruned = true;
      }
    }
  }
  return pruned;
}

function home(opts: PortRegistryOptions): string {
  return opts.homeDir ?? homedir();
}

function idFor(salt: string, key: string): string {
  return createHash('sha256')
    .update(salt + key)
    .digest('hex')
    .slice(0, 12);
}

/** Symlinks resolved; case folded on Windows, whose paths are case-insensitive. */
async function projectKey(projectDir: string): Promise<string> {
  let path = resolve(projectDir);
  try {
    path = await realpath(path);
  } catch {
    // A folder that doesn't exist yet keeps its resolved path.
  }
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

async function load(homeDir: string): Promise<PortRegistry> {
  const path = registryPath(homeDir);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new PortRegistryError(
        `${path} can't be read (${String((err as NodeJS.ErrnoException).code)})`,
      );
    }
    return create(homeDir);
  }
  let parsed;
  try {
    parsed = RegistrySchema.safeParse(JSON.parse(text));
  } catch {
    parsed = undefined;
  }
  if (parsed?.success !== true) {
    // Replacing it would change every project id and forget every port, so leave it be.
    throw new PortRegistryError(
      `${path} is damaged. Fix or delete it, then run \`flutterdeck init\`.`,
    );
  }
  return parsed.data;
}

/**
 * Exclusive create, so two daemons starting at once on a new machine can't each write
 * a different salt; the loser reads the winner's file.
 */
async function create(homeDir: string): Promise<PortRegistry> {
  const registry: PortRegistry = {
    version: 1,
    salt: randomBytes(32).toString('base64url'),
    projects: {},
  };
  await mkdir(join(homeDir, REGISTRY_DIR), { recursive: true, mode: 0o700 });
  try {
    await writeFile(registryPath(homeDir), serialise(registry), { mode: 0o600, flag: 'wx' });
    return registry;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return load(homeDir);
    throw err;
  }
}

/** A fresh 0600 temp file renamed into place, so readers never see half a file. */
async function save(homeDir: string, registry: PortRegistry): Promise<void> {
  const path = registryPath(homeDir);
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, serialise(registry), { mode: 0o600, flag: 'wx' });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

function serialise(registry: PortRegistry): string {
  return JSON.stringify(registry, null, 2) + '\n';
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolveFree) => {
    const server = createServer();
    server.once('error', () => resolveFree(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolveFree(true)));
  });
}
