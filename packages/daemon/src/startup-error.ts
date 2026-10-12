import { DaemonAlreadyRunningError } from './daemon.js';

/** One readable line for the terminal; stacks only help when debugging the daemon itself. */
export function formatStartupError(err: unknown): string {
  if (err instanceof DaemonAlreadyRunningError) return err.message;
  const message = err instanceof Error ? err.message : String(err);
  return `project-deck daemon could not start: ${message.replace(/\s*\n\s*/g, ' ')}`;
}
