import type { CapabilityPlugin, PluginSurface } from '@/services/socket/types';
import type {
  CommandsAddResponse,
  CommandsListResponse,
  CommandsRemoveResponse,
  CommandsUpdateResponse,
} from './types';

/**
 * commands capability — `client.commands.list|add|remove|update` (quick
 * commands, issue #95) plus the `server.commands.changed` push that keeps the
 * UI's command palette fresh. Wire strings live only in this file; the typed
 * API is what consumers import (module singleton in index.ts).
 */
export class CommandsPlugin implements CapabilityPlugin {
  readonly name = 'commands';

  private connection: PluginSurface | null = null;
  private generation = 0;
  private callbacks = new Set<() => void>();

  /**
   * Bind the plugin to a connection. A later install replaces an earlier
   * binding (same instance, new surface — StrictMode remount); the returned
   * teardown is generation-guarded so a stale release can never detach the
   * newer binding.
   */
  install(connection: PluginSurface): () => void {
    const generation = ++this.generation;
    this.connection = connection;

    const unsub = connection.subscribe('server.commands.changed', () => {
      this.notifyChanged();
    });

    return () => {
      unsub();
      if (this.generation === generation && this.connection === connection) {
        this.connection = null;
      }
      // A released plugin must never notify stale consumers.
      this.callbacks.clear();
    };
  }

  /** Fetch all quick commands in display order. */
  async listCommands(): Promise<CommandsListResponse> {
    return this.requireConnection().request<CommandsListResponse>('client.commands.list', {});
  }

  /** Add a quick command. `raw: true` disables shell quoting/expansion. */
  async addCommand(
    label: string,
    command: string,
    raw = false,
  ): Promise<CommandsAddResponse> {
    return this.requireConnection().request<CommandsAddResponse>('client.commands.add', {
      label,
      command,
      raw,
    });
  }

  /** Remove a quick command by id. */
  async removeCommand(id: string): Promise<CommandsRemoveResponse> {
    return this.requireConnection().request<CommandsRemoveResponse>('client.commands.remove', {
      id,
    });
  }

  /** Update a subset of a quick command's fields by id. */
  async updateCommand(
    id: string,
    fields: { label?: string; command?: string; raw?: boolean },
  ): Promise<CommandsUpdateResponse> {
    return this.requireConnection().request<CommandsUpdateResponse>('client.commands.update', {
      id,
      ...fields,
    });
  }

  /** Subscribe to quick-command changes pushed by the server. */
  onCommandsChanged(cb: () => void): () => void {
    this.callbacks.add(cb);
    return () => {
      this.callbacks.delete(cb);
    };
  }

  private notifyChanged(): void {
    for (const cb of this.callbacks) {
      cb();
    }
  }

  private requireConnection(): PluginSurface {
    if (!this.connection) {
      throw new Error('commands feature is not connected');
    }
    return this.connection;
  }
}
