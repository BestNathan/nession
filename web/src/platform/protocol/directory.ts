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
 * ## Unknown and absent are different answers, and used to be the same one
 *
 * `manifestFor` returned `null` both for an agent that advertised nothing and
 * for one this connection had not heard about yet, and the note defending that
 * said collapsing them was "the safe direction". It was not. It made *not
 * having fetched yet* resolve to *this target is a Legacy Peer, relay it
 * naming no version* — which is a manifest still in flight being read as a
 * version-negotiation that succeeded. That is the bypass `#963` removes, and
 * separating the two answers is what removes it: neither is a success, so
 * neither can be mistaken for one.
 *
 * ## Replaced wholesale, never merged
 *
 * The agent list is a snapshot. Merging would keep the manifest of an agent
 * that has since gone away, and a stale manifest is worse than a missing one:
 * it resolves to a version the target no longer serves, which is exactly the
 * "target manifest stale" case the server's gate exists to catch.
 */

/**
 * What this connection knows about one target's protocols.
 *
 * Three answers, because two of them look alike and are not: a target nobody
 * has told us about yet, and a target that was seen and advertised nothing.
 * The first is a gap in *our* knowledge; the second is a fact about the
 * target. Only the second is something a caller may relay against, and there
 * is no outcome here that means "go ahead unversioned".
 */
export type TargetProtocols =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'none' }
  | { readonly kind: 'present'; readonly manifest: ProtocolManifest };

/**
 * The directory input for a list of agents, keyed by agent id.
 *
 * Structural rather than `Agent[]`, so this module stays free of the product's
 * own vocabulary — the only thing it needs from an agent is that it has an id
 * and may carry a manifest.
 *
 * `undefined` folds to `null` here, and that is still right: "the server did
 * not say" and "the agent advertised none" both come from a *snapshot that
 * named this agent*, so neither is `unknown`. `unknown` is the id being absent
 * from the snapshot altogether, which only {@link ProtocolDirectory} can tell.
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
   * advertised nothing is a different fact from an agent we have not seen, and
   * {@link targetProtocols} is where the difference is readable.
   */
  publish(manifests: ReadonlyMap<string, ProtocolManifest | null>): void {
    this.manifests.clear();
    for (const [agentId, manifest] of manifests) {
      this.manifests.set(agentId, manifest);
    }
  }

  /**
   * What this connection knows about `agentId`.
   *
   * The map's `has` and `get` are both needed: `get` alone cannot tell an entry
   * holding `null` from no entry at all, and that is exactly the distinction
   * this method exists to expose.
   */
  targetProtocols(agentId: string): TargetProtocols {
    if (!this.manifests.has(agentId)) {
      return { kind: 'unknown' };
    }
    const manifest = this.manifests.get(agentId) ?? null;
    return manifest === null ? { kind: 'none' } : { kind: 'present', manifest };
  }
}
