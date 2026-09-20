import type { ProtocolManifest } from './types';

/**
 * What each target this connection can reach advertises.
 *
 * ## Why this is a directory and not a lookup done by each caller
 *
 * Resolution has to be **per target** (#678 Phase 4): the Web talks to several
 * agents through one server, and one agent's contract versions say nothing
 * about another's. Resolving once for the connection — the thing the design
 * explicitly rules out — is what a shared "the" manifest would produce.
 *
 * So the manifests are kept per agent id, filled by whichever plugin learns
 * them (`product/agent`, from `client.agents.list`) and read by whichever
 * plugin has to address a call (`capabilities/git`, `capabilities/claude-code`).
 * The transport is the only thing both sides already share, which is why the
 * directory hangs off the surface rather than out of one plugin and into
 * another.
 *
 * ## Unknown and absent are the same answer
 *
 * `manifestFor` returns `null` both for an agent that advertised nothing and
 * for one this connection has not heard about yet. Both are Legacy Peers from
 * here: the call goes out naming no version and relays as it did before any of
 * this existed. Collapsing them is the safe direction — *not having fetched
 * yet* must never read as *this target refused*.
 *
 * ## Replaced wholesale, never merged
 *
 * The agent list is a snapshot. Merging would keep the manifest of an agent
 * that has since gone away, and a stale manifest is worse than a missing one:
 * it resolves to a version the target no longer serves, which is exactly the
 * "target manifest stale" case the server's gate exists to catch.
 */
/**
 * The directory input for a list of agents, keyed by agent id.
 *
 * Structural rather than `Agent[]`, so this module stays free of the product's
 * own vocabulary — the only thing it needs from an agent is that it has an id
 * and may carry a manifest.
 *
 * `undefined` folds to `null` here: "the server did not say" and "the agent
 * advertised none" resolve identically, and a caller should not have to
 * remember which of the two its source produces.
 */
export function manifestsOf(
  agents: readonly { agent_id: string; protocols?: ProtocolManifest | null }[],
): Map<string, ProtocolManifest | null> {
  return new Map(agents.map((agent) => [agent.agent_id, agent.protocols ?? null] as const));
}

export class ProtocolDirectory {
  private readonly manifests = new Map<string, ProtocolManifest | null>();

  /**
   * Replace every entry with this snapshot.
   *
   * `null` values are meaningful and are kept: an agent that was seen and
   * advertised nothing is a Legacy Peer, which is a different fact from an
   * agent we have not seen. Both resolve the same today, but only one of them
   * is worth being able to tell apart when that changes.
   */
  publish(manifests: ReadonlyMap<string, ProtocolManifest | null>): void {
    this.manifests.clear();
    for (const [agentId, manifest] of manifests) {
      this.manifests.set(agentId, manifest);
    }
  }

  /** What `agentId` advertises, or `null` — see the class note on that value. */
  manifestFor(agentId: string): ProtocolManifest | null {
    return this.manifests.get(agentId) ?? null;
  }
}
