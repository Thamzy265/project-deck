#!/usr/bin/env node
// @ts-check
/**
 * FlutterDeck's Claude Code hook: tells the project's local daemon when Claude finishes,
 * waits for the developer, or reloads the app through the Dart MCP server. It reads the
 * hook's JSON from stdin and POSTs a small event to http://127.0.0.1:<port>/api/events,
 * with the port and token from `.flutterdeck/runtime.json`.
 *
 * Rules (docs/design/m2-dashboard.md, "Failure plan" and "Privacy"):
 * - It never blocks Claude: everything ends within 2 s, the exit code is always 0 and
 *   nothing is printed, whatever goes wrong.
 * - It sends only what the design allows: the event type, the session id, Claude Code's
 *   waiting message, and a reload's outcome with a short error cut and stripped of paths.
 *   Never `last_assistant_message`, `transcript_path`, `cwd` or the tool's input (whose
 *   app URI holds a VM service auth code).
 * - The project folder may come from a cloned repository, so it never follows a link in
 *   `.flutterdeck/` and does nothing unless the folder was set up by `flutterdeck init`.
 *
 * Standalone on purpose: no dependencies and no build, so it works wherever the plugin is.
 */
import { createHash } from 'node:crypto';
import { constants, lstatSync, realpathSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Same limits as the daemon's HookEventInput (packages/core). */
export const MAX_WAITING_MESSAGE = 2000;
export const MAX_RELOAD_MESSAGE = 300;
export const MAX_SESSION_ID = 128;
export const TOKEN_HEADER = 'x-deck-token';

export const DEADLINE_MS = 2000;
/** Stop's input holds Claude's last message, which can be long; beyond this, give up. */
export const MAX_STDIN_BYTES = 4 * 1024 * 1024;
const MAX_RUNTIME_BYTES = 65_536;

/**
 * Claude Code notifications that mean "Claude is waiting for you" (hooks reference,
 * 15 Oct 2026): a permission prompt, an idle prompt, an MCP server's input form, and a
 * background session or teammate that needs input.
 */
const WAITING_TYPES = new Set([
  'permission_prompt',
  'idle_prompt',
  'elicitation_dialog',
  'agent_needs_input',
]);
/**
 * The Dart MCP server's reload tools, under any server name that says dart in any case.
 * The same text is the PostToolUse matcher in hooks.json (a test keeps them equal); Claude
 * Code's matchers have no flags, hence the character classes.
 */
export const RELOAD_TOOL_PATTERN = '^mcp__.*[Dd][Aa][Rr][Tt].*__hot_re(load|start)$';
const RELOAD_TOOL = new RegExp(RELOAD_TOOL_PATTERN);

/**
 * @typedef {{ type: 'claude.done', sessionId?: string }
 *   | { type: 'claude.waiting', sessionId?: string, message?: string }
 *   | { type: 'claude.reload', sessionId?: string, ok: boolean,
 *       kind: 'hot-reload' | 'hot-restart', message?: string }} DeckEvent
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Cuts to `max` characters, marking the cut.
 * @param {string} text
 * @param {number} max
 */
function cut(text, max) {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/** The raw error is cut to this many characters before any pattern runs. */
export const MAX_RAW_RELOAD_MESSAGE = 1024;

/*
 * Every pattern below is linear: each starts only where a lookbehind allows (one character
 * back), its prefix is bounded, and its tail is one greedy class run. A timer can't stop a
 * running regular expression, so a backtracking pattern on a long error would hold the hook
 * past its deadline.
 */
/** `scheme://…`: scheme at most 31 characters, starting where no scheme character is. */
const URI = /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{0,30}:\/\/[^\s"'`<>]*/g;
/** `host:port[/…]` without a scheme: localhost, IPv4 or bracketed IPv6. */
const BARE_ADDRESS =
  /(?<![A-Za-z0-9.:\]-])(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9A-Fa-f:.]{2,45}\]):\d{1,5}(?:\/[^\s"'`<>]*)?/gi;
/**
 * `name:port/…` for any other host name (`my-mac.local:52345/<code>=/ws`). The path is
 * required, so `main.dart:12:3` stays.
 */
const HOST_ADDRESS =
  /(?<![A-Za-z0-9._:/\]-])[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*:\d{1,5}\/[^\s"'`<>]*/g;
/** Percent-decoding rounds: a URI inside a query can be encoded once, twice or three times. */
const DECODE_ROUNDS = 3;
/** An absolute path runs to the end of the line or a quote, spaces included. */
const PATH_TAIL = String.raw`[^\n"'` + '`' + ']*';
/** Windows drive paths: `C:\…` or `C:/…`. */
const DRIVE_PATH = new RegExp(String.raw`(?<![A-Za-z0-9])[A-Za-z]:[\\/]` + PATH_TAIL, 'g');
/** UNC paths: `\\server\share…`. */
const UNC_PATH = new RegExp(String.raw`(?<![A-Za-z0-9._~/\\-])\\\\` + PATH_TAIL, 'g');
/** POSIX and home paths: `/…` or `~/…` after any character that can't be part of a path. */
const POSIX_PATH = new RegExp(String.raw`(?<![A-Za-z0-9._~/\\-])~?/` + PATH_TAIL, 'g');

/**
 * Decodes `%XX` escapes up to DECODE_ROUNDS times, so an encoded URI (`ws%3A%2F%2F…`) meets
 * the address patterns. Byte by byte: the text is only shown, never decoded further.
 * @param {string} text
 */
function decodePercent(text) {
  let out = text;
  for (let round = 0; round < DECODE_ROUNDS && /%[0-9A-Fa-f]{2}/.test(out); round++) {
    out = out.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
  // Still encoded after the last round: the patterns can't see into it, so the whole word
  // goes (fail closed, R2-2). Anchored at a word start, so it stays linear.
  return out.replace(STILL_ENCODED, '[address]');
}

const STILL_ENCODED = /(?<![^\s"'`<>])[^\s"'`<>]*%[0-9A-Fa-f]{2}[^\s"'`<>]*/g;

/**
 * Removes control and invisible format characters (a zero-width space could hide a path
 * from the patterns), then addresses and absolute paths, then squeezes white space. No cut:
 * scrubReloadMessage cuts before and after.
 * @param {string} text
 */
export function scrubText(text) {
  return decodePercent(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[^\P{Cc}\n]/gu, ' ')
    .replace(/\p{Cf}/gu, '')
    .replace(URI, '[address]')
    .replace(BARE_ADDRESS, '[address]')
    .replace(HOST_ADDRESS, '[address]')
    .replace(DRIVE_PATH, '[path]')
    .replace(UNC_PATH, '[path]')
    .replace(POSIX_PATH, '[path]')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A reload error for the Activity feed: no addresses (VM service URIs carry auth codes),
 * no absolute paths (they name the user and the project), one line, short. The raw text
 * is cut first, so the work is bounded whatever the error's length.
 * @param {string} text
 */
export function scrubReloadMessage(text) {
  // 2 code units per character at most, so this slice still holds the first 1024.
  const raw = Array.from(text.slice(0, 2 * MAX_RAW_RELOAD_MESSAGE))
    .slice(0, MAX_RAW_RELOAD_MESSAGE)
    .join('');
  // The first line says what failed; the rest is a flutter_tools stack trace (QA F-B5-1).
  // The Activity row already says "Reload failed", so the tool's own prefix goes.
  // The prefix goes first, so "Hot reload failed:" alone on its line leaves the reason on
  // the next one (R2-6).
  const rest = raw.replace(
    /^\s*hot (?:reload|restart) failed(?:[ \t]*[:.]|[ \t]*(?=\r|\n|$))/i,
    '',
  );
  const reason = rest.split(/\r\n?|\n/).find((line) => line.trim() !== '') ?? '';
  return cut(scrubText(reason), MAX_RELOAD_MESSAGE);
}

/**
 * The text of an MCP tool result as Claude Code passes it: a string, a list of content
 * blocks, or an object holding `content`.
 * @param {unknown} response
 * @returns {{ text: string, isError: boolean }}
 */
function toolResult(response) {
  if (typeof response === 'string') return { text: response, isError: false };
  const blocks = Array.isArray(response)
    ? response
    : isObject(response) && Array.isArray(response.content)
      ? response.content
      : [];
  const text = blocks
    .map((b) => (isObject(b) && typeof b.text === 'string' ? b.text : ''))
    .filter((t) => t !== '')
    .join(' ');
  return { text, isError: isObject(response) && response.isError === true };
}

/**
 * Turns a hook's input into the event the daemon accepts, or undefined to send nothing.
 * Built field by field, so nothing else in the input can reach the daemon.
 * @param {unknown} input
 * @returns {DeckEvent | undefined}
 */
export function toDeckEvent(input) {
  if (!isObject(input)) return undefined;
  const sid = input.session_id;
  const session =
    typeof sid === 'string' && sid.length <= MAX_SESSION_ID && /^[\w.-]+$/.test(sid)
      ? { sessionId: sid }
      : {};
  switch (input.hook_event_name) {
    case 'Stop':
    case 'SubagentStop':
      return { type: 'claude.done', ...session };
    case 'Notification': {
      if (typeof input.notification_type !== 'string') return undefined;
      if (!WAITING_TYPES.has(input.notification_type)) return undefined;
      const message =
        typeof input.message === 'string' && input.message.trim() !== ''
          ? { message: cut(input.message, MAX_WAITING_MESSAGE) }
          : {};
      return { type: 'claude.waiting', ...session, ...message };
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const match = typeof input.tool_name === 'string' ? RELOAD_TOOL.exec(input.tool_name) : null;
      if (match === null) return undefined;
      // A cancelled call says nothing about the app.
      if (input.is_interrupt === true) return undefined;
      const kind = match[1] === 'start' ? 'hot-restart' : 'hot-reload';
      let ok;
      let detail;
      if (input.hook_event_name === 'PostToolUseFailure') {
        ok = false;
        detail = typeof input.error === 'string' ? input.error : '';
      } else {
        const result = toolResult(input.tool_response);
        // The Dart MCP server answers "Hot reload failed." with isError; older Claude Code
        // versions may still report that as PostToolUse.
        ok = !result.isError && !/\bfailed\b/i.test(result.text);
        detail = result.text;
      }
      const message = ok ? '' : scrubReloadMessage(detail);
      return {
        type: 'claude.reload',
        ...session,
        ok,
        kind,
        ...(message === '' ? {} : { message }),
      };
    }
    default:
      return undefined;
  }
}

/**
 * The project folder: Claude Code's project root, or else the hook's working folder.
 * @param {Record<string, string | undefined>} env
 * @param {unknown} input
 */
export function projectDirOf(env, input) {
  const fromEnv = env.CLAUDE_PROJECT_DIR;
  if (typeof fromEnv === 'string' && isAbsolute(fromEnv)) return fromEnv;
  const cwd = isObject(input) ? input.cwd : undefined;
  return typeof cwd === 'string' && isAbsolute(cwd) ? cwd : undefined;
}

/**
 * A plain file only: lstat must say "file", and O_NOFOLLOW refuses a link that appears in
 * between (Windows has no O_NOFOLLOW; there the lstat is the check).
 * @param {string} path
 * @param {number} maxBytes
 */
async function readPlainFile(path, maxBytes) {
  if (!lstatSync(path).isFile()) return undefined;
  const nofollow = /** @type {{ O_NOFOLLOW?: number }} */ (constants).O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_RDONLY | nofollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Port and token of the project's daemon, or undefined if the folder isn't set up, the
 * daemon isn't running, or anything there is a link or looks wrong.
 * @param {string} projectDir
 * @returns {Promise<{ port: number, token: string } | undefined>}
 */
export async function readDaemonAddress(projectDir) {
  const stateDir = join(projectDir, '.flutterdeck');
  const dir = lstatSync(stateDir, { throwIfNoEntry: false });
  if (dir === undefined || dir.isSymbolicLink() || !dir.isDirectory()) return undefined;
  // `flutterdeck init` writes config.json; without it the folder isn't set up.
  const config = lstatSync(join(stateDir, 'config.json'), { throwIfNoEntry: false });
  if (config === undefined || !config.isFile()) return undefined;
  const text = await readPlainFile(join(stateDir, 'runtime.json'), MAX_RUNTIME_BYTES);
  if (text === undefined) return undefined;
  /** @type {unknown} */
  const runtime = JSON.parse(text);
  if (!isObject(runtime)) return undefined;
  const { port, token } = runtime;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined;
  }
  // Header-safe and the length the daemon makes.
  if (typeof token !== 'string' || !/^[\x21-\x7e]{32,512}$/.test(token)) return undefined;
  return { port, token };
}

/**
 * One request to the daemon on 127.0.0.1. Resolves with the status and body, or undefined
 * on any error or after `timeoutMs`.
 * @param {{ port: number, method: string, path: string, headers?: Record<string, string>,
 *   body?: string, timeoutMs: number }} opts
 * @returns {Promise<{ status: number, body: string } | undefined>}
 */
function call(opts) {
  return new Promise((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: opts.port,
        method: opts.method,
        path: opts.path,
        headers: opts.headers,
        timeout: opts.timeoutMs,
      },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        let size = 0;
        res.on('data', (/** @type {Buffer} */ chunk) => {
          size += chunk.length;
          if (size <= 65_536) chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', () => resolve(undefined));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(undefined));
    req.end(opts.body);
  });
}

/**
 * This project's id as its daemon shows it on /api/health: the first 12 hex characters of
 * SHA-256(salt + project path), the salt from the user's `~/.flutterdeck/ports.json`. The
 * same as core's readProjectIdentity, kept here so the hook needs no build. Read only;
 * undefined when the registry is missing, a link or damaged.
 * @param {string} projectDir
 * @param {string} [home] the user's home folder
 */
export async function ownProjectId(projectDir, home = homedir()) {
  try {
    const text = await readPlainFile(join(home, '.flutterdeck', 'ports.json'), 8_388_608);
    if (text === undefined) return undefined;
    /** @type {unknown} */
    const registry = JSON.parse(text);
    if (!isObject(registry) || typeof registry.salt !== 'string' || registry.salt.length < 32) {
      return undefined;
    }
    let key = resolve(projectDir);
    try {
      // The native realpath, as core's fs/promises realpath: it gives the on-disk case,
      // subst drives and long names, so both work out the same id (R2-1).
      key = realpathSync.native(key);
    } catch {
      // A folder that is gone keeps its resolved path, as in core.
    }
    if (process.platform === 'win32') key = key.toLowerCase();
    return createHash('sha256')
      .update(registry.salt + key)
      .digest('hex')
      .slice(0, 12);
  } catch {
    return undefined;
  }
}

/**
 * Sends the event if the daemon on the port is this project's FlutterDeck. The health
 * check comes first, so the token is never handed to another program that took a stale
 * port, or to another project's daemon (a project id that isn't ours, or one we can't work
 * out, means no send).
 * @param {{ port: number, token: string }} daemon
 * @param {DeckEvent} event
 * @param {number} deadline epoch ms
 * @param {string} projectDir
 */
export async function send(daemon, event, deadline, projectDir) {
  const left = () => Math.max(1, deadline - Date.now());
  const health = await call({
    port: daemon.port,
    method: 'GET',
    path: '/api/health',
    timeoutMs: left(),
  });
  if (health === undefined || health.status !== 200) return false;
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(health.body);
  } catch {
    return false;
  }
  if (!isObject(parsed) || parsed.name !== 'project-deck') return false;
  // Both sides must agree: an id only one of them knows is a mismatch too (R2-3). Neither
  // knowing one (no port registry on this machine) still sends.
  if (parsed.projectId !== (await ownProjectId(projectDir))) return false;
  const body = JSON.stringify(event);
  const res = await call({
    port: daemon.port,
    method: 'POST',
    path: '/api/events',
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      [TOKEN_HEADER]: daemon.token,
    },
    body,
    timeoutMs: left(),
  });
  return res?.status === 200;
}

/**
 * Reads stdin up to MAX_STDIN_BYTES; undefined if it is larger or fails.
 * @param {NodeJS.ReadableStream & { destroy?: () => void }} stdin
 * @returns {Promise<string | undefined>}
 */
function readStdin(stdin) {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    stdin.on('data', (/** @type {Buffer} */ chunk) => {
      size += chunk.length;
      if (size > MAX_STDIN_BYTES) {
        stdin.destroy?.();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stdin.on('error', () => resolve(undefined));
  });
}

/** Runs the hook. Never throws. */
export async function main() {
  const deadline = Date.now() + DEADLINE_MS;
  try {
    const text = await readStdin(process.stdin);
    if (text === undefined) return;
    /** @type {unknown} */
    const input = JSON.parse(text);
    const event = toDeckEvent(input);
    if (event === undefined) return;
    const projectDir = projectDirOf(process.env, input);
    if (projectDir === undefined) return;
    const daemon = await readDaemonAddress(projectDir);
    if (daemon === undefined) return;
    await send(daemon, event, deadline, projectDir);
  } catch {
    // Anything at all: say nothing and let Claude carry on.
  }
}

function isEntryPoint() {
  try {
    const script = process.argv[1];
    return script !== undefined && pathToFileURL(realpathSync(script)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // Nothing may reach Claude: no output, exit 0, and never longer than the deadline.
  process.exitCode = 0;
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
  setTimeout(() => process.exit(0), DEADLINE_MS).unref();
  void main().finally(() => process.exit(0));
}
