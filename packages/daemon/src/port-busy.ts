import {
  HOW_TO_CHANGE_PORT,
  deckCommand,
  portTakenText,
  unresponsiveText,
} from '@project-deck/core';
import { z } from 'zod';

/** How long the health probe of a busy port may take. */
export const HEALTH_PROBE_TIMEOUT_MS = 2000;

/** The configured port is taken. Never names a process: we never run a process lookup. */
export class PortBusyError extends Error {
  constructor(
    readonly port: number,
    readonly holder:
      | { kind: 'pitdeck'; projectId: string | undefined }
      | { kind: 'unresponsive' }
      | { kind: 'other' },
  ) {
    super(
      holder.kind === 'pitdeck'
        ? `Another Pitdeck (project ${holder.projectId ?? 'unknown'}) uses port ${port}. Stop it with \`${deckCommand('stop')}\` in that project, or pick another port here: ${HOW_TO_CHANGE_PORT}`
        : holder.kind === 'unresponsive'
          ? unresponsiveText(port, HEALTH_PROBE_TIMEOUT_MS / 1000)
          : portTakenText(port),
    );
  }
}

const HealthSchema = z.object({
  name: z.literal('pitdeck'),
  projectId: z
    .string()
    .regex(/^[0-9a-f]{12}$/)
    .optional(),
});

/** Asks whatever listens on `port` whether it is a Pitdeck daemon. */
export async function identifyPortHolder(port: number): Promise<PortBusyError> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    if (res.status === 200) {
      const health = HealthSchema.safeParse(await res.json());
      if (health.success) {
        return new PortBusyError(port, { kind: 'pitdeck', projectId: health.data.projectId });
      }
    } else {
      await res.body?.cancel();
    }
  } catch (err) {
    // Too slow is not "another program": a stalled Pitdeck holds its port the same way.
    if (err instanceof Error && err.name === 'TimeoutError') {
      return new PortBusyError(port, { kind: 'unresponsive' });
    }
    // Not HTTP, not JSON, or reserved by the system: not ours.
  }
  return new PortBusyError(port, { kind: 'other' });
}
