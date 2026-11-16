import {
  WIRE as SERVER_MCP_ENDPOINT_WIRE,
  type ServerMcpEndpointResponse,
} from '@/generated/protocol/core/server-mcp-endpoint/v1';
import { WIRE as SERVER_INFO_WIRE } from '@/generated/protocol/core/server-info/v1';
import type { TransportPlugin, PluginSurface } from '@/platform/socket/types';
import type { ServerInfo } from '@/types';

/**
 * server capability — `server.info`. The wire string is the generated
 * binding; the typed API is what consumers import (module singleton in
 * index.ts).
 */
export class ServerPlugin implements TransportPlugin {
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
    return this.requireConnection().request<ServerInfo>(SERVER_INFO_WIRE, {});
  }

  /**
   * Whether this Server mounted its embedded MCP endpoint, and where (#3600).
   *
   * The answer is the Server's startup configuration, not a health check. A
   * caller that needs reachability performs its own bounded handshake — the
   * Claude Connect preflight does exactly that through the Agent.
   */
  async mcpEndpoint(): Promise<ServerMcpEndpointResponse> {
    return this.requireConnection().request<ServerMcpEndpointResponse>(
      SERVER_MCP_ENDPOINT_WIRE,
      {},
    );
  }

  private requireConnection(): PluginSurface {
    if (!this.connection) {
      throw new Error('server feature is not connected');
    }
    return this.connection;
  }
}
