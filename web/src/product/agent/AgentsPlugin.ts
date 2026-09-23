import { WIRE as AGENT_DELETE_WIRE } from '@/generated/protocol/core/server-agent-delete/v1';
import { WIRE as AGENT_LIST_WIRE } from '@/generated/protocol/core/server-agent-list/v1';
import { WIRE as AGENT_RENAME_WIRE } from '@/generated/protocol/core/server-agent-rename/v1';
import { manifestsOf } from '@/platform/protocol';
import type { TransportPlugin, PluginSurface } from '@/platform/socket/types';
import type { Agent } from '@/types';
import type { AgentDeleteResponse, AgentRenameResponse, AgentsListResponse } from './types';

type AgentsCallback = (agents: Agent[]) => void;

/** One registration, tagged with the install generation that created it. */
interface GenerationEntry<T> {
  cb: T;
  generation: number;
}

/**
 * agents capability — `server.agent.list` / `server.agent.rename` /
 * `server.agent.delete` plus the two change notifications that keep the UI's
 * agent list fresh. The wire strings are the generated bindings; the typed API
 * is what consumers import (module singleton in index.ts).
 */
export class AgentsPlugin implements TransportPlugin {
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
      // The list's own wire, so a message of this type that is *not* a pending
      // reply still reaches consumers — a reply whose request already timed
      // out, say, which `MessageRouter` routes here once its id has left the
      // pending map. It used to be a hand-written name, which is what let this
      // subscription drift from the wire the request actually uses; the
      // generated binding cannot drift.
      connection.subscribe(AGENT_LIST_WIRE, (payload) => {
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

  /**
   * Fetch the full agent registry.
   *
   * Publishes the manifests it carried before returning, and it has to be here
   * rather than left to the `server.agent.list` subscription in {@link install}:
   * `MessageRouter.handleIncoming` **returns** once it has correlated a reply
   * with its pending request, so a response never reaches subscribers. That
   * subscription therefore does not fire for this call — it is kept for a
   * message of the same wire that is *not* a pending reply, which nothing sends
   * today. Publishing only from there would have left the directory permanently
   * empty, and an empty directory is not a visible failure: every call resolves
   * as a Legacy Peer and goes out unversioned, which is the pre-`#678` request.
   */
  async listAgents(): Promise<Agent[]> {
    const response = await this.requireConnection().request<AgentsListResponse>(
      AGENT_LIST_WIRE,
      {},
    );
    this.publishProtocols(response.agents);
    return response.agents;
  }

  /** Rename an agent's display name. Pass null to clear (reset to config/hostname). */
  async renameAgent(agentId: string, displayName: string | null): Promise<Agent> {
    const response = await this.requireConnection().request<AgentRenameResponse>(
      AGENT_RENAME_WIRE,
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
      AGENT_DELETE_WIRE,
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
    this.publishProtocols(agents);
    for (const entry of this.callbacks) {
      entry.cb(agents);
    }
  }

  /**
   * Hand each agent's advertised protocol set to the connection's directory
   * (`#678`, Phase 4).
   *
   * Called from both paths that actually receive an agent list — `listAgents`
   * and the `agents.changed` push, the latter via {@link notify}. Wholesale
   * replacement, not a merge: this list is a snapshot, and keeping an entry for
   * an agent it no longer contains would resolve against a manifest nobody
   * serves any more.
   */
  private publishProtocols(agents: Agent[]): void {
    if (!this.connection) {
      return;
    }
    this.connection.protocols.publish(manifestsOf(agents));
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
