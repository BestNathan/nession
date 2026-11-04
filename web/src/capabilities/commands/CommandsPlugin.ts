import {
  WIRE as LIST_WIRE,
  type ClientCommandsListResponsePayload,
  type QuickCommandItem,
} from '@/generated/protocol/core/server-commands-list/v1';
import type { ConnectionState, PluginSurface, TransportPlugin } from '@/platform/socket/types';

/**
 * The saved-command transport (#95), restored for the Commands view (#2710).
 *
 * The server is the data owner: `server.commands.list` answers the ordered
 * list and `server.commands.changed` says it moved. This plugin is the Web
 * adapter for exactly that pair — it holds no cache, no ordering and no
 * persistence, because a second copy of the list would be a second owner free
 * to disagree with the server.
 *
 * It is a **TransportPlugin**, not a Product Capability: this class has no
 * presence and is never activated. The capability identity lives beside the
 * body that peeks at the list (`product/terminal/quickCommands`).
 */
export class CommandsPlugin implements TransportPlugin {
  readonly name = 'commands';

  private connection: PluginSurface | null = null;
  private generation = 0;
  private readonly changedListeners = new Set<() => void>();
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();

  /**
   * Bind to a connection. A later install replaces an earlier binding; the
   * teardown is generation-guarded so a stale release cannot detach the newer
   * binding (StrictMode mounts twice).
   */
  install(connection: PluginSurface): () => void {
    const generation = ++this.generation;
    this.connection = connection;

    const unsubChanged = connection.subscribe('server.commands.changed', () => {
      for (const listener of this.changedListeners) {
        listener();
      }
    });
    const unsubState = connection.onConnectionStateChange((state) => {
      for (const listener of this.stateListeners) {
        listener(state);
      }
    });
    // A listener that subscribed before this install (a body mounted while the
    // route was still connecting) gets the state the binding starts in.
    for (const listener of this.stateListeners) {
      listener(connection.connectionState);
    }

    return () => {
      unsubChanged();
      unsubState();
      if (this.generation === generation && this.connection === connection) {
        this.connection = null;
      }
    };
  }

  /** The ordered server list. */
  async listCommands(): Promise<readonly QuickCommandItem[]> {
    const response = await this.requireConnection().request<ClientCommandsListResponsePayload>(
      LIST_WIRE,
      {},
    );
    return response.commands;
  }

  /** The server pushed a change; refetch. */
  onCommandsChanged(listener: () => void): () => void {
    this.changedListeners.add(listener);
    return () => {
      this.changedListeners.delete(listener);
    };
  }

  /**
   * The connection state this plugin is bound to, or `null` when no surface is
   * installed (the fixture route installs one; a body rendered with no
   * connection sees `null`).
   */
  connectionState(): ConnectionState | null {
    return this.connection?.connectionState ?? null;
  }

  /** Connection transitions, with the current state delivered on subscribe. */
  onConnectionStateChange(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    const current = this.connectionState();
    if (current !== null) {
      listener(current);
    }
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  private requireConnection(): PluginSurface {
    if (!this.connection) {
      throw new Error('commands capability is not connected');
    }
    return this.connection;
  }
}

/** One binding per WebSocketService lifetime, shared by every Commands body. */
export const commandsApi = new CommandsPlugin();
