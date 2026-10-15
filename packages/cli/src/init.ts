/**
 * `flutterdeck init`: sets a Flutter project up for FlutterDeck (plan, "flutterdeck init";
 * design note D2). It checks everything first and writes only when every file is safe to
 * change, so a refusal leaves the project as it was. It only adds: a missing port in
 * config.json, one .gitignore block, one launch.json entry.
 */
import { join } from 'node:path';
import type { DeckConfig } from '@project-deck/core';
import {
  ConfigError,
  STATE_DIR,
  StateDirError,
  checkStateDir,
  configPath,
  pathScrubber,
  readConfig,
} from '@project-deck/core/node';
import {
  FIRST_PORT,
  PortRegistryError,
  acquireFileLock,
  allocatePort,
  claimConfigPort,
} from '@project-deck/daemon';
import { constants } from 'node:fs';
import { access, mkdir, rmdir } from 'node:fs/promises';
import { newConfigText, withPort } from './config-merge.js';
import { detectFlutterProject, readApplicationId } from './flutter-project.js';
import { addIgnoreBlock } from './gitignore.js';
import type { Io } from './io.js';
import { messageOf } from './io.js';
import { mergeLaunchJson } from './launch-json.js';
import { CLI_NAME } from './name.js';
import type { RunTool } from './prerequisites.js';
import { checkPrerequisites, formatPrerequisites } from './prerequisites.js';
import type { FileState } from './project-files.js';
import { UnsafeFileError, inspectDir, inspectFile, writeAtomic } from './project-files.js';

export interface InitOptions {
  projectDir: string;
  /** Where the per-user port registry lives (the user's home folder). */
  homeDir: string;
  run: RunTool;
  /** Absolute path of this CLI's main.js: the printed .mcp.json runs `node <it> mcp`. */
  cliMainPath: string;
  /** Test seam: whether nothing listens on a port. */
  isFree?: (port: number) => Promise<boolean>;
  /** Test seam: the cross-process lock (the daemon's acquireFileLock). */
  acquireLock?: typeof acquireFileLock;
  io: Io;
}

const CONFIG_SHOWN = `${STATE_DIR}/config.json`;
const GITIGNORE_SHOWN = '.gitignore';
const CLAUDE_DIR = '.claude';
const LAUNCH_SHOWN = `${CLAUDE_DIR}/launch.json`;
/** A new config, .gitignore or launch.json: readable by all, like files git creates. */
const NEW_FILE_MODE = 0o644;

/** Thrown for a file init won't change; the message is shown as it is. */
class Refused extends Error {}

interface Plan {
  config: { state: FileState; settings: DeckConfig | undefined };
  gitignore: FileState;
  claudeDir: 'missing' | 'dir';
  launch: FileState;
}

type Outcome = 'created' | 'updated' | 'unchanged';

export async function runInit(opts: InitOptions): Promise<number> {
  const { io, projectDir } = opts;
  const project = await detectFlutterProject(projectDir);
  if (!project.ok) {
    io.err(project.reason);
    return 1;
  }
  // Slow (flutter --version can take a while), so before the lock is taken.
  const prerequisites = await checkPrerequisites(opts.run);
  const applicationId = await readApplicationId(projectDir);
  try {
    // Under the lock, another init can't change the files between this run's read and
    // its write, so two runs at once end with one block and one entry.
    const { plan, port, changes } = await withInitLock(
      projectDir,
      async () => {
        const plan = await inspect(projectDir);
        const port = await choosePort(opts, plan.config.settings);
        const changes = await apply(projectDir, plan, port.port);
        return { plan, port, changes };
      },
      opts.acquireLock ?? acquireFileLock,
    );

    io.out(`FlutterDeck init in ${projectDir}`);
    const name = project.name ?? 'this app';
    io.out(
      `Flutter project: ${name}${applicationId === undefined ? '' : ` (Android app id ${applicationId})`}`,
    );
    io.out('');
    io.out('Prerequisites:');
    for (const line of formatPrerequisites(prerequisites)) io.out(line);
    io.out('');
    io.out(`Dashboard port: ${port.port} (${port.source})`);
    if (port.warning !== undefined) io.out(`Warning: ${port.warning}`);
    if (plan.config.settings?.logs.redact === false) {
      io.out('Note: Masking for Claude is off (logs.redact is false in config.json).');
    }
    io.out('');
    io.out('Changes:');
    for (const [file, outcome, detail] of changes) {
      io.out(`  ${outcome.padEnd(10)}${file}${outcome === 'unchanged' ? '' : ` (${detail})`}`);
    }
    io.out('');
    for (const line of nextSteps(opts.cliMainPath)) io.out(line);
    return 0;
  } catch (err) {
    // Every form of the project and home folders (Windows slashes, case, 8.3 names) is
    // hidden: messages name files by their project path only.
    const hide = pathScrubber(projectDir, { home: opts.homeDir });
    if (
      err instanceof Refused ||
      err instanceof UnsafeFileError ||
      err instanceof StateDirError ||
      err instanceof ConfigError ||
      err instanceof PortRegistryError
    ) {
      io.err(hide(err.message));
      io.err('init changed nothing in the project.');
      return 1;
    }
    // fs errors name absolute paths; only project-relative ones are shown.
    io.err(`init failed: ${hide(messageOf(err))}`);
    return 1;
  }
}

/** Each step takes milliseconds; a lock this old was left by a crash. */
const INIT_LOCK_STALE_MS = 10_000;
const INIT_LOCK = 'init.lock';

/**
 * Runs `fn` holding `.flutterdeck/init.lock`. The folder is made for the lock when it is
 * missing, and removed again (only if still empty) when `fn` fails, so a refused init
 * leaves the project as it was.
 */
const ANOTHER_INIT = `Another \`${CLI_NAME} init\` is running in this project; try again.`;

async function withInitLock<T>(
  projectDir: string,
  fn: () => Promise<T>,
  acquire: typeof acquireFileLock,
): Promise<T> {
  // A linked .flutterdeck is refused before the lock goes into it.
  await checkStateDir(projectDir);
  const stateDir = join(projectDir, STATE_DIR);
  let made = false;
  if ((await inspectDir(stateDir, STATE_DIR)) === 'missing') {
    await checkWritable(projectDir, 'the project folder');
    try {
      await mkdir(stateDir);
      made = true;
    } catch (err) {
      // Another init made it a moment ago.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  } else {
    await checkWritable(stateDir, STATE_DIR);
  }
  let release: (() => Promise<void>) | undefined;
  try {
    try {
      release = await acquire(
        stateDir,
        INIT_LOCK,
        { staleMs: INIT_LOCK_STALE_MS, retryMs: 20 },
        () => new Refused(ANOTHER_INIT),
      );
    } catch (err) {
      // A concurrent run that refused removed the .flutterdeck it made, between the
      // folder's creation and this lock's.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Refused(ANOTHER_INIT);
      throw err;
    }
    return await fn();
  } catch (err) {
    await release?.();
    release = undefined;
    // rmdir removes only an empty folder: nothing else of the user's can go.
    if (made) await rmdir(stateDir).catch(() => undefined);
    throw err;
  } finally {
    await release?.();
  }
}

/**
 * Refuses a folder init would write into but can't, before anything is written, so a
 * read-only folder never leaves the project half set up.
 */
async function checkWritable(dir: string, shown: string): Promise<void> {
  try {
    await access(dir, constants.W_OK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown error';
    throw new Refused(
      `init can't write to ${shown} (${code === 'EACCES' || code === 'EPERM' ? 'permission denied' : code}).`,
    );
  }
}

/** Reads and checks every file init may change, before anything is written. */
async function inspect(projectDir: string): Promise<Plan> {
  // A linked .flutterdeck is refused before anything inside it is looked at.
  await checkStateDir(projectDir);
  const configState = await inspectFile(configPath(projectDir), CONFIG_SHOWN);
  let settings: DeckConfig | undefined;
  if (configState.kind === 'file') {
    try {
      settings = await readConfig(projectDir);
    } catch (err) {
      if (err instanceof ConfigError) {
        throw new Refused(`${err.message} Fix it, then run \`${CLI_NAME} init\` again.`);
      }
      throw err;
    }
  }
  const gitignore = await inspectFile(join(projectDir, GITIGNORE_SHOWN), GITIGNORE_SHOWN);
  const claudeDir = await inspectDir(join(projectDir, CLAUDE_DIR), CLAUDE_DIR);
  const launch =
    claudeDir === 'missing'
      ? ({ kind: 'missing' } as const)
      : await inspectFile(join(projectDir, CLAUDE_DIR, 'launch.json'), LAUNCH_SHOWN);
  if (launch.kind === 'file') {
    // Any valid port: this only checks that the file can be merged.
    const check = mergeLaunchJson(launch.text, FIRST_PORT);
    if (check.kind === 'refused') throw new Refused(`${LAUNCH_SHOWN} ${check.reason}.`);
  }

  // Every folder a write may go to. .claude is checked whenever it exists, since the
  // entry's port isn't known yet.
  const stateDir = await inspectDir(join(projectDir, STATE_DIR), STATE_DIR);
  const ignoreChanges =
    addIgnoreBlock(gitignore.kind === 'file' ? gitignore.text : undefined) !== undefined;
  if (stateDir === 'missing' || claudeDir === 'missing' || ignoreChanges) {
    await checkWritable(projectDir, 'the project folder');
  }
  if (stateDir === 'dir') await checkWritable(join(projectDir, STATE_DIR), STATE_DIR);
  if (claudeDir === 'dir') await checkWritable(join(projectDir, CLAUDE_DIR), CLAUDE_DIR);
  return { config: { state: configState, settings }, gitignore, claudeDir, launch };
}

interface ChosenPort {
  port: number;
  source: string;
  warning?: string;
}

async function choosePort(
  opts: InitOptions,
  settings: DeckConfig | undefined,
): Promise<ChosenPort> {
  const configured = settings?.port;
  const registry = { homeDir: opts.homeDir };
  if (configured === undefined) {
    const port = await allocatePort(opts.projectDir, {
      ...registry,
      ...(opts.isFree === undefined ? {} : { isFree: opts.isFree }),
    });
    return { port, source: 'from the per-user registry' };
  }
  const other = await claimConfigPort(opts.projectDir, configured, registry);
  const chosen: ChosenPort = { port: configured, source: `kept from ${CONFIG_SHOWN}` };
  if (other !== undefined) {
    chosen.warning = `port ${configured} is also registered to another project (project ${other}); if both run at once, one will fail. Remove "port" from ${CONFIG_SHOWN} and run \`${CLI_NAME} init\` to pick a new one.`;
  }
  return chosen;
}

async function apply(
  projectDir: string,
  plan: Plan,
  port: number,
): Promise<[string, Outcome, string][]> {
  const changes: [string, Outcome, string][] = [];

  const config = plan.config.state;
  await mkdir(join(projectDir, STATE_DIR), { recursive: true });
  if (config.kind === 'missing') {
    await writeAtomic(configPath(projectDir), newConfigText(port), NEW_FILE_MODE);
    changes.push([CONFIG_SHOWN, 'created', `version 1, port ${port}`]);
  } else if (plan.config.settings?.port === undefined) {
    await writeAtomic(configPath(projectDir), withPort(config.text, port), config.mode);
    changes.push([CONFIG_SHOWN, 'updated', `added port ${port}`]);
  } else {
    changes.push([CONFIG_SHOWN, 'unchanged', '']);
  }

  const ignore = plan.gitignore;
  const ignored = addIgnoreBlock(ignore.kind === 'file' ? ignore.text : undefined);
  if (ignored === undefined) {
    changes.push([GITIGNORE_SHOWN, 'unchanged', '']);
  } else {
    const mode = ignore.kind === 'file' ? ignore.mode : NEW_FILE_MODE;
    await writeAtomic(join(projectDir, GITIGNORE_SHOWN), ignored, mode);
    changes.push([
      GITIGNORE_SHOWN,
      ignore.kind === 'file' ? 'updated' : 'created',
      `ignores FlutterDeck's token, log and lock files`,
    ]);
  }

  const launch = plan.launch;
  const merged = mergeLaunchJson(launch.kind === 'file' ? launch.text : undefined, port);
  if (merged.kind === 'refused') throw new Refused(`${LAUNCH_SHOWN} ${merged.reason}.`);
  if (merged.kind === 'unchanged') {
    changes.push([LAUNCH_SHOWN, 'unchanged', '']);
  } else {
    // recursive: no error if it appeared since the inspect.
    if (plan.claudeDir === 'missing')
      await mkdir(join(projectDir, CLAUDE_DIR), { recursive: true });
    const mode = launch.kind === 'file' ? launch.mode : NEW_FILE_MODE;
    await writeAtomic(join(projectDir, CLAUDE_DIR, 'launch.json'), merged.text, mode);
    changes.push([
      LAUNCH_SHOWN,
      launch.kind === 'file' ? 'updated' : 'created',
      `"FlutterDeck" opens http://127.0.0.1:${port}`,
    ]);
  }
  return changes;
}

function nextSteps(cliMainPath: string): string[] {
  const snippet = {
    mcpServers: {
      dart: { type: 'stdio', command: 'dart', args: ['mcp-server'] },
      flutterdeck: { type: 'stdio', command: 'node', args: [cliMainPath, 'mcp'] },
    },
  };
  return [
    'Next steps:',
    `  1. Start the dashboard: ${CLI_NAME} start`,
    '  2. In Claude Desktop, open the Browser pane and choose "FlutterDeck".',
    '  3. Give Claude the MCP servers: add these to .mcp.json in the project',
    '     (the FlutterDeck plugin will do this for you later):',
    '',
    ...JSON.stringify(snippet, null, 2).split('\n'),
  ];
}
