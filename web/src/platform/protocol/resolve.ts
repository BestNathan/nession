import type { ProtocolManifest } from './types';

/**
 * Consumer Requirements ∩ Provider Manifest → the contract version to use.
 *
 * The consumer-side half of `nession-protocol`'s resolver (`#678`, Phase 4).
 * The rules are the design's, and each is a way this goes wrong quietly:
 *
 * 1. **Highest common version**, not the provider's newest. A consumer that
 *    speaks v1 talking to a provider offering v1 and v3 must land on v1;
 *    picking v3 because it is newest sends a payload the consumer cannot read.
 *    Same rule as the Rust `select_version` — the two must agree, because a
 *    consumer that resolves differently from the server's check gets its call
 *    refused for a version it thought it had chosen.
 * 2. **Versions are not assumed contiguous.** `[1, 3]` is a legitimate answer
 *    set, so the intersection is computed over what is declared rather than by
 *    walking down from a maximum.
 * 3. **No intersection disables one unit, not the connection.** The result is a
 *    value the caller renders, not a failure that unwinds anything — an Agent
 *    that cannot do `git.diff` is still an Agent.
 * 4. **A peer with no manifest is not a peer that refused.** It is a Legacy
 *    Peer: it relays exactly as it did before any of this existed, which means
 *    *not naming a version*. Absence is not a claim about versions.
 */

/**
 * What resolving one unit against one target produced.
 *
 * A union rather than a nullable version so the three outcomes stay distinct
 * sentences to a reader. `legacy` in particular is not a failure and must never
 * be reported as one — it is the pre-`#678` path, working as before.
 */
export type Resolution =
  | { readonly kind: 'resolved'; readonly version: number }
  | { readonly kind: 'legacy' }
  | { readonly kind: 'not-advertised' }
  | { readonly kind: 'no-common-version'; readonly offered: readonly number[] };

/**
 * The highest version both sides offer, or `null` when they share none.
 *
 * `null` for an empty list either side, which is the same answer for the same
 * reason: nothing can be chosen from nothing.
 */
export function selectVersion(
  requirements: readonly number[],
  offered: readonly number[],
): number | null {
  let best: number | null = null;
  for (const version of offered) {
    if (!requirements.includes(version)) { continue; }
    if (best === null || version > best) { best = version; }
  }
  return best;
}

/**
 * Resolve one protocol unit for one target.
 *
 * `manifest` is `null` for a target that advertised none — a Legacy Peer, or an
 * agent this client has not heard about yet. Both answer `legacy`, and that is
 * the safe direction for the second case too: not having fetched yet must not
 * read as "this target refused".
 */
export function resolveContract(
  unit: string,
  requirements: readonly number[],
  manifest: ProtocolManifest | null | undefined,
): Resolution {
  if (!manifest) {
    return { kind: 'legacy' };
  }
  const support = manifest.protocols[unit];
  if (!support) {
    return { kind: 'not-advertised' };
  }
  const version = selectVersion(requirements, support.versions);
  if (version === null) {
    return { kind: 'no-common-version', offered: [...support.versions] };
  }
  return { kind: 'resolved', version };
}

/**
 * The sentence a refusal gets, or `null` when there is nothing to refuse.
 *
 * Both sides are named, for the reason the server's own refusal names both:
 * "version not supported" is not actionable, "`agent-a` offers `git.status` at
 * [v1, v2], and this client cannot read any of them" is. The wording matches
 * the server's `contract_not_supported` refusal so a reader cannot tell — and
 * does not need to care — which side answered.
 */
export function refusalMessage(
  unit: string,
  target: string,
  resolution: Resolution,
): string | null {
  switch (resolution.kind) {
    case 'resolved':
    case 'legacy':
      return null;
    case 'not-advertised':
      return `\`${target}\` does not advertise \`${unit}\``;
    case 'no-common-version':
      return `\`${target}\` offers \`${unit}\` at [${resolution.offered.map((v) => `v${v}`).join(', ')}], which this client cannot read`;
    default: {
      // Exhaustiveness: a new outcome must be given a sentence here rather than
      // silently falling through to a refusal nobody wrote.
      const unhandled: never = resolution;
      throw new Error(`unhandled resolution: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * The payload to send `unit` to `target` with, or a throw explaining why this
 * call is one this client must not make.
 *
 * This is the whole of what a capability has to do to become a resolving
 * consumer: name the unit, name the target, hand over its own requirements.
 *
 * ## Why the refusal happens here rather than at the server
 *
 * The server checks the version a caller names (`#856`) and would refuse this
 * call too — but only if the caller named one. Sending *nothing* is not a
 * refusal: it is the Legacy Peer path, and a v1-shaped payload would go to a
 * target that serves only v2. So a consumer that knows it cannot speak the
 * target's contract has to say so itself; the server's check is a second
 * boundary against a stale manifest, not the first one.
 *
 * Throws a plain `Error`. The server's refusal is a structured payload
 * (`error`, `protocol`, `named_version`, `offered_versions`); nothing on this
 * side branches on those fields yet, and inventing an error class no caller
 * reads would be a shape without a consumer. The message carries both sides, so
 * the one thing a reader needs — who has to move — is not lost.
 */
export function addressedPayload(args: {
  unit: string;
  target: string;
  requirements: readonly number[];
  manifest: ProtocolManifest | null;
  payload: Record<string, unknown>;
}): Record<string, unknown> {
  const { unit, target, requirements, manifest, payload } = args;
  const resolution = resolveContract(unit, requirements, manifest);
  const refusal = refusalMessage(unit, target, resolution);
  if (refusal) {
    throw new Error(refusal);
  }
  return resolution.kind === 'resolved'
    ? { ...payload, contract_version: resolution.version }
    : { ...payload };
}
