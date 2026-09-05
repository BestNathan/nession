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
/** One registration, tagged with the install generation that created it. */
interface GenerationEntry<T> {
  cb: T;
  generation: number;
}

export class CommandsPlugin implements CapabilityPlugin {
  readonly name = 'commands';

  private connection: PluginSurface | null = null;
  private generation = 0;
  private callbacks = new Set<GenerationEntry<() => void>>();

  /**
   * Bind the plugin to a connection. A later install replaces an earlier
   * binding (same instance, new surface — StrictMode remount).
   *
   * Registration lifecycle contract: every onCommandsChanged subscription is
   * tagged with the generation of the install that registered it. The
   * returned teardown releases generation G:
   * - unsubscribes G's surface subscriptions;
   * - if G is still the current release, nulls `this.connection` and clears
   *   ALL registrations (nothing newer exists);
   * - otherwise a newer binding owns the connection — only registrations
   *   tagged G are dropped, so the newer binding's consumers keep firing.
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
        // Current release — no newer binding exists, so every remaining
        // registration belongs to this release. Drop them all.
        this.callbacks.clear();
      } else {
        // Stale release — a newer binding is active. Drop only the
        // registrations this release created; never touch newer ones.
        this.dropGeneration(generation);
      }
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
    const entry: GenerationEntry<() => void> = { cb, generation: this.generation };
    this.callbacks.add(entry);
    return () => {
      this.callbacks.delete(entry);
    };
  }

  private notifyChanged(): void {
    for (const entry of this.callbacks) {
      entry.cb();
    }
  }

  /** Drop the registrations made under one (now-released) install generation. */
  private dropGeneration(generation: number): void {
    for (const entry of this.callbacks) {
      if (entry.generation === generation) {
        this.callbacks.delete(entry);
      }
    }
  }

  private requireConnection(): PluginSurface {
    if (!this.connection) {
      throw new Error('commands feature is not connected');
    }
    return this.connection;
  }
}
