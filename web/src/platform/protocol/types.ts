/**
 * The wire shape of a peer's Protocol Set (`#678`).
 *
 * The TypeScript mirror of the Rust `ProtocolManifest`, field for field:
 * `protocols` maps a canonical protocol id (`git.status`, `claude-code.read`)
 * to what the peer offers for it. Nothing here is a Nession product concept —
 * it is what any Nession peer, in any language, puts on the wire.
 */

/** Which versions of one contract a peer offers, and what carries them. */
export interface ContractSupport {
  /**
   * Contract versions, as integers.
   *
   * Integers rather than `"v1"` because "v" is a display convention: a peer
   * reading this in another language sees the same number, and the prefix is
   * re-derived where it is shown rather than parsed back out.
   */
  versions: number[];
  /**
   * The wire message types this unit travels as.
   *
   * Absent on a peer that predates the field, and `[]` is not the same claim as
   * absent for the *router* — but neither is a claim this module makes. It
   * resolves versions, not routing.
   */
  wire?: string[];
}

/** What a peer advertises it can serve. */
export interface ProtocolManifest {
  /** Who offers this set — an agent id, a server, a runtime name. */
  provider: string;
  protocols: Record<string, ContractSupport>;
  /**
   * Diagnostics only, and deliberately not read by `resolve`.
   *
   * Resolving compatibility from a release number is the failure this whole
   * issue exists to remove. The cheapest way to keep it true is for the
   * resolver to be structurally unable to see this field.
   */
  software_version?: string;
}
