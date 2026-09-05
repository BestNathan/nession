import type { CapabilityPlugin, PluginSurface } from '@/services/socket/types';
import type { ServerInfo } from '@/types';

/**
 * server capability — `client.server.info`. Wire strings live only in this
 * file; the typed API is what consumers import (module singleton in
 * index.ts).
 */
export class ServerPlugin implements CapabilityPlugin {
  readonly name = 'server';

  private connection: PluginSurface | null = null;
  private generation = 0;

  /**
   * Bind the plugin to a connection. A later install replaces an earlier
   * binding (same instance, new surface — StrictMode remount); the returned
   * teardown is generation-guarded so a stale release can never detach the
   * newer binding.
   */
  install(connection: PluginSurface): () => void {
    const generation = ++this.generation;
    this.connection = connection;
    return () => {
      if (this.generation === generation && this.connection === connection) {
        this.connection = null;
      }
    };
  }

  /** Fetch server info (version, uptime, counts). */
  async serverInfo(): Promise<ServerInfo> {
    return this.requireConnection().request<ServerInfo>('client.server.info', {});
  }

  private requireConnection(): PluginSurface {
    if (!this.connection) {
      throw new Error('server feature is not connected');
    }
    return this.connection;
  }
}
