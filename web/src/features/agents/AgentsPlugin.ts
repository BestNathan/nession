import type { CapabilityPlugin, PluginSurface } from '@/services/socket/types';
import type { Agent } from '@/types';
import type { AgentDeleteResponse, AgentRenameResponse, AgentsListResponse } from './types';

type AgentsCallback = (agents: Agent[]) => void;

/** One registration, tagged with the install generation that created it. */
interface GenerationEntry<T> {
  cb: T;
  generation: number;
}

/**
 * agents capability — `client.agents.list` / `client.agent.rename` /
 * `client.agent.delete` plus the two change notifications that keep the UI's
 * agent list fresh. Wire strings live only in this file; the typed API is
 * what consumers import (module singleton in index.ts).
 */
export class AgentsPlugin implements CapabilityPlugin {
  readonly name = 'agents';

  private connection: PluginSurface | null = null;
  private generation = 0;
  private callbacks = new Set<GenerationEntry<AgentsCallback>>();

  /**
   * Bind the plugin to a connection. A later install replaces an earlier
   * binding (same instance, new surface — StrictMode remount).
   *
   * Registration lifecycle contract: every onAgentsChanged subscription is
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

    const unsubs = [
      connection.subscribe('agents.changed', (payload) => {
        const agents = (payload as { agents?: Agent[] })?.agents;
        if (agents) {
          this.notify(agents);
        }
      }),
      connection.subscribe('client.agents.list.response', (payload) => {
        const agents = (payload as { agents?: Agent[] })?.agents;
        if (agents) {
          this.notify(agents);
        }
      }),
    ];

    return () => {
      for (const unsub of unsubs) {
        unsub();
      }
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

  /** Fetch the full agent registry. */
  async listAgents(): Promise<Agent[]> {
    const response = await this.requireConnection().request<AgentsListResponse>(
      'client.agents.list',
      {},
    );
    return response.agents;
  }

  /** Rename an agent's display name. Pass null to clear (reset to config/hostname). */
  async renameAgent(agentId: string, displayName: string | null): Promise<Agent> {
    const response = await this.requireConnection().request<AgentRenameResponse>(
      'client.agent.rename',
      { agent_id: agentId, display_name: displayName },
    );
    if (!response.success || !response.agent) {
      throw new Error(response.error || 'Rename failed');
    }
    return response.agent;
  }

  /** Delete an offline agent and all its sessions. Rejects if agent is online. */
  async deleteAgent(agentId: string): Promise<void> {
    const response = await this.requireConnection().request<AgentDeleteResponse>(
      'client.agent.delete',
      { agent_id: agentId },
    );
    if (!response.success) {
      throw new Error(response.error || 'Delete failed');
    }
  }

  /** Subscribe to agent list changes (server push or list response). */
  onAgentsChanged(cb: AgentsCallback): () => void {
    const entry: GenerationEntry<AgentsCallback> = { cb, generation: this.generation };
    this.callbacks.add(entry);
    return () => {
      this.callbacks.delete(entry);
    };
  }

  private notify(agents: Agent[]): void {
    for (const entry of this.callbacks) {
      entry.cb(agents);
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
      throw new Error('agents feature is not connected');
    }
    return this.connection;
  }
}
