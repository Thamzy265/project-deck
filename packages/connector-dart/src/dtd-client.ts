import { z } from 'zod';
import type { JsonRpcClientOptions } from './json-rpc.js';
import { JsonRpcClient } from './json-rpc.js';

const VmServiceSchema = z.object({
  uri: z.string(),
  exposedUri: z.string().nullish(),
  name: z.string().nullish(),
});
export type DtdVmService = z.infer<typeof VmServiceSchema>;

const RegisteredServicesSchema = z.object({ dtdServices: z.array(z.string()) });
const VmServicesSchema = z.object({ vmServices: z.array(VmServiceSchema) });
const StreamNotifySchema = z.object({
  streamId: z.string(),
  eventKind: z.string(),
  eventData: z.unknown(),
});

export const CONNECTED_APP_STREAM = 'ConnectedApp';

export type VmServiceChange =
  { kind: 'registered'; service: DtdVmService } | { kind: 'unregistered'; uri: string };

/** The read-only slice of the Dart Tooling Daemon protocol we need. We never register apps. */
export class DtdClient {
  private constructor(private readonly rpc: JsonRpcClient) {}

  static async connect(wsUri: string, opts?: JsonRpcClientOptions): Promise<DtdClient> {
    return new DtdClient(await JsonRpcClient.connect(wsUri, opts));
  }

  async supportsConnectedApp(): Promise<boolean> {
    const parsed = RegisteredServicesSchema.safeParse(await this.rpc.call('getRegisteredServices'));
    return parsed.success && parsed.data.dtdServices.includes('ConnectedApp.getVmServices');
  }

  async getVmServices(): Promise<DtdVmService[]> {
    return VmServicesSchema.parse(await this.rpc.call('ConnectedApp.getVmServices')).vmServices;
  }

  /** Subscribes to app registrations. The listener is attached before subscribing so nothing is missed. */
  async watch(cb: (change: VmServiceChange) => void): Promise<() => void> {
    const off = this.rpc.onNotification('streamNotify', (params) => {
      const event = StreamNotifySchema.safeParse(params);
      if (!event.success || event.data.streamId !== CONNECTED_APP_STREAM) return;
      const service = VmServiceSchema.safeParse(event.data.eventData);
      if (!service.success) return;
      if (event.data.eventKind === 'VmServiceRegistered')
        cb({ kind: 'registered', service: service.data });
      if (event.data.eventKind === 'VmServiceUnregistered')
        cb({ kind: 'unregistered', uri: service.data.uri });
    });
    await this.rpc.call('streamListen', { streamId: CONNECTED_APP_STREAM });
    return off;
  }

  onClose(cb: () => void): () => void {
    return this.rpc.onClose(cb);
  }

  close(): void {
    this.rpc.close();
  }
}
