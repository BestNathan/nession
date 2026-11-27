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
  /** Monotonic count of agent-list snapshots published to the protocol
   *  directory, used to order replies and pushes on one physical socket. */
  private snapshotSeq = 0;
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
      // `<emitter>.<subject>.<event>`: the first segment is the runtime that
      // *sends* it, which for a notification is the only runtime there is.
      // It used to be `agents.changed`, with no emitter at all — the one
      // position where an operation's first segment means "who answers" and a
      // notification's means "who sends", so the same slot answered two
      // different questions depending on the wire.
      connection.subscribe('server.agents.changed', (payload) => {
        const agents = (payload as { agents?: Agent[] })?.agents;
        if (agents) {
          this.notify(connection, agents);
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
          this.notify(connection, agents);
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
    const connection = this.requireConnection();
    // Ordering *within* one physical socket (#4602 SC-04). The generation fence
    // below only refuses a reply from a replaced socket; two list requests can
    // still be outstanding on the same one, and the older reply resolving last
    // would publish an older protocol manifest over a newer one. A push counts
    // as a newer snapshot too. The directory is wholesale-replaced, so a stale
    // publish is not a harmless no-op: it resolves calls against manifests
    // nobody serves any more.
    const snapshotSeqAtStart = this.snapshotSeq;
    // The answer describes the Agent registry on the physical socket the
    // request went out on. Capture that generation only when the request is
    // issued on a live socket: a request queued behind the readiness gate will
    // travel on whatever socket connects next, so its answer is current by
    // construction. Without the capture, a delayed reply from a replaced
    // socket could install its snapshot on the socket that replaced it
    // (#3990).
    const physicalGeneration = connection.connectionState === 'connected'
      ? connection.physicalGeneration
      : undefined;
    const response = await connection.request<AgentsListResponse>(
      AGENT_LIST_WIRE,
      {},
    );
    if (this.isCurrent(connection, physicalGeneration)
      && this.snapshotSeq === snapshotSeqAtStart) {
      this.publishProtocols(connection, response.agents);
    }
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

  private notify(connection: PluginSurface, agents: Agent[]): void {
    // A message describes the surface it arrived on. After a rebind the old
    // surface is no longer this plugin's connection, so its snapshot must
    // neither overwrite the live directory nor reach consumers as if it were
    // current.
    if (this.connection !== connection) {
      return;
    }
    this.publishProtocols(connection, agents);
    for (const entry of this.callbacks) {
      entry.cb(agents);
    }
  }

  /**
   * Whether an answer received from `connection` still describes the current
   * connection.
   *
   * The generation is captured before an asynchronous request. When the
   * surface can report one, a response captured on an earlier generation is
   * refused even though it settled on this object; `connected` is required
   * because between loss and a replacement socket there is no connection whose
   * snapshot a late response could be (#3990).
   *
   * The generation is optional because legacy/test surfaces may not track it;
   * the real transport always does.
   */
  private isCurrent(
    connection: PluginSurface,
    physicalGeneration?: number,
  ): boolean {
    if (this.connection !== connection || connection.connectionState !== 'connected') {
      return false;
    }
    return physicalGeneration === undefined
      || (connection.physicalGeneration ?? -1) === physicalGeneration;
  }

  /**
   * Hand each agent's advertised protocol set to `connection`'s directory
   * (`#678`, Phase 4).
   *
   * Reached from both paths that actually receive an agent list — `listAgents`
   * and the `server.agents.changed` push, the latter via {@link notify} — after
   * the caller established the snapshot belongs to the current connection
   * (#3990). Wholesale replacement, not a merge: this list is a snapshot, and
   * keeping an entry for an agent it no longer contains would resolve against
   * a manifest nobody serves any more.
   */
  private publishProtocols(connection: PluginSurface, agents: Agent[]): void {
    this.snapshotSeq += 1;
    connection.protocols.publish(manifestsOf(agents));
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
