export interface ConnectorUris {
  dtdUris: string[];
  vmServiceUris: string[];
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * Merges addresses given as flags with `DECK_DTD_URIS` / `DECK_VM_SERVICE_URIS`
 * (comma-separated). The addresses carry auth codes; env vars keep them out of `ps`.
 */
export function connectorUris(flags: ConnectorUris, env: NodeJS.ProcessEnv): ConnectorUris {
  return {
    dtdUris: [...flags.dtdUris, ...splitList(env.DECK_DTD_URIS)],
    vmServiceUris: [...flags.vmServiceUris, ...splitList(env.DECK_VM_SERVICE_URIS)],
  };
}
