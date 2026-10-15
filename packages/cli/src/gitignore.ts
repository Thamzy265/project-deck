/**
 * The `.gitignore` block `init` adds once: the files under `.flutterdeck/` that hold the
 * token, the daemon's messages or locks. `config.json` stays out of it, so a team can
 * commit its settings.
 */
import { CLI_NAME } from './name.js';
import { lineEnding } from './text-format.js';

export const GITIGNORE_BEGIN = `# >>> ${CLI_NAME} (added by \`${CLI_NAME} init\`)`;
export const GITIGNORE_END = `# <<< ${CLI_NAME}`;
export const IGNORED: readonly string[] = [
  '.flutterdeck/state.json',
  '.flutterdeck/runtime.json',
  '.flutterdeck/daemon.log',
  '.flutterdeck/*.lock',
  '.flutterdeck/*.tmp',
  '.flutterdeck/*.stale',
];

/**
 * The file with the block appended, or undefined when the block is already there. A block
 * the user has edited since counts as there: their edit wins.
 */
export function addIgnoreBlock(text: string | undefined): string | undefined {
  const current = text ?? '';
  if (current.split(/\r?\n/).some((line) => line.trim() === GITIGNORE_BEGIN)) return undefined;
  const eol = lineEnding(current);
  const block = [GITIGNORE_BEGIN, ...IGNORED, GITIGNORE_END, ''].join(eol);
  if (current === '') return block;
  const ended = current.endsWith('\n') ? current : current + eol;
  return ended + eol + block;
}
