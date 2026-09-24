import type { TargetProtocols } from './directory';

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
 * 4. **There is no Legacy Peer.** A peer whose manifest is not known yet is one
 *    this client cannot address, not one it may address unversioned. `#963`
 *    removed that path: it let a manifest still in flight be read as a
 *    negotiation that had succeeded.
 */

/**
 * What resolving one unit against one target produced.
 *
 * A union rather than a nullable version so the outcomes stay distinct
 * sentences to a reader. Every outcome except `resolved` is a refusal the
 * caller must report — including `not-ready`, which used to be the success
 * path `legacy`.
 */
export type Resolution =
  | { readonly kind: 'resolved'; readonly version: number }
  | { readonly kind: 'not-ready' }
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
 * `unknown` and `none` are kept apart because they are different sentences to
 * a reader, not because they behave differently — neither resolves, and
 * neither falls back to an unversioned call. "We have not heard from this
 * target yet" asks the caller to wait and retry; "this target advertises
 * nothing" asks nobody to move, because nothing can.
 */
export function resolveContract(
  unit: string,
  requirements: readonly number[],
  target: TargetProtocols,
): Resolution {
  if (target.kind === 'unknown') {
    return { kind: 'not-ready' };
  }
  if (target.kind === 'none') {
    return { kind: 'not-advertised' };
  }
  const support = target.manifest.protocols[unit];
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
 * The sentence a refusal gets. Total over the outcomes that *are* refusals, so
 * a caller cannot reach a `throw` with nothing to say about why.
 *
 * Both sides are named, for the reason the server's own refusal names both:
 * "version not supported" is not actionable, "`agent-a` offers `git.status` at
 * [v1, v2], and this client cannot read any of them" is. The wording matches
 * the server's `contract_not_supported` refusal so a reader cannot tell — and
 * does not need to care — which side answered.
 */
function refusalFor(
  unit: string,
  target: string,
  resolution: Exclude<Resolution, { kind: 'resolved' }>,
): string {
  switch (resolution.kind) {
    case 'not-ready':
      return `\`${target}\` is not in the protocol directory yet, so \`${unit}\` cannot be resolved to a contract version — wait for the agent list and retry`;
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
 * The sentence a resolution gets, or `null` when there is nothing to refuse.
 *
 * The `null` arm exists for callers that want to render rather than throw; the
 * one that must act on it is {@link addressedPayload}, which throws.
 */
export function refusalMessage(
  unit: string,
  target: string,
  resolution: Resolution,
): string | null {
  return resolution.kind === 'resolved' ? null : refusalFor(unit, target, resolution);
}

/**
 * The payload to send `unit` to `target` with, or a throw explaining why this
 * call is one this client must not make.
 *
 * This is the whole of what a capability has to do to become a resolving
 * consumer: name the unit, name the target, hand over its own requirements.
 *
 * ## Why there is no third outcome
 *
 * Every path here either resolves a version or throws. That is the point: the
 * function used to have an else-branch that sent the payload *without*
 * `contract_version` when the manifest was missing, and because the server
 * relays a caller that names nothing, that branch was a version negotiation
 * bypassed by a slow list. There is no longer an unversioned payload to send —
 * a caller with nothing to resolve has nothing to send.
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
  protocols: TargetProtocols;
  payload: Record<string, unknown>;
}): Record<string, unknown> {
  const { unit, target, requirements, protocols, payload } = args;
  const resolution = resolveContract(unit, requirements, protocols);
  if (resolution.kind === 'resolved') {
    return { ...payload, contract_version: resolution.version };
  }
  throw new Error(refusalFor(unit, target, resolution));
}
