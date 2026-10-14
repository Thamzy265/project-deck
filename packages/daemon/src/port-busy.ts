import { z } from 'zod';

/** How long the health probe of a busy port may take. */
export const HEALTH_PROBE_TIMEOUT_MS = 2000;

const HOW_TO_CHANGE =
  'Run `flutterdeck init` to pick another port, or change "port" in .flutterdeck/config.json (and the url in .claude/launch.json).';

/** The configured port is taken. Never names a process: we never run a process lookup. */
export class PortBusyError extends Error {
  constructor(
    readonly port: number,
    readonly holder: { kind: 'flutterdeck'; projectId: string | undefined } | { kind: 'other' },
  ) {
    super(
      holder.kind === 'flutterdeck'
        ? `Another FlutterDeck (project ${holder.projectId ?? 'unknown'}) uses port ${port}. Stop it with \`flutterdeck stop\` in that project, or pick another port here. ${HOW_TO_CHANGE}`
        : `Another program uses port ${port}. Stop that program, or pick another port. ${HOW_TO_CHANGE}`,
    );
  }
}

const HealthSchema = z.object({
  name: z.literal('project-deck'),
  projectId: z
    .string()
    .regex(/^[0-9a-f]{12}$/)
    .optional(),
});

/** Asks whatever listens on `port` whether it is a FlutterDeck daemon. */
export async function identifyPortHolder(port: number): Promise<PortBusyError> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    if (res.status === 200) {
      const health = HealthSchema.safeParse(await res.json());
      if (health.success) {
        return new PortBusyError(port, { kind: 'flutterdeck', projectId: health.data.projectId });
      }
    } else {
      await res.body?.cancel();
    }
  } catch {
    // Not HTTP, not JSON, too slow, or reserved by the system: not ours either way.
  }
  return new PortBusyError(port, { kind: 'other' });
}
