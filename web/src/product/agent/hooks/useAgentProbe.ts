import { useEffect, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { orderByLatency, testAddresses } from '@/shared/lib/addressSelection';
import { probeResultsAtom, type AgentProbe } from '@/product/agent/state/probe';
import type { ProbedAddress } from '@/types';

export interface AgentProbeInput {
  /** Agent whose candidates are being tested. A null id probes nothing. */
  agentId: string | null;
  /** Candidates to test. An empty list probes nothing (a relay attach has none). */
  addresses: ProbedAddress[];
  /**
   * Credential presented at the upgrade.
   *
   * **A probe without one probes nothing.** Since #1013 the agent refuses a
   * bare upgrade, so measuring without a credential cannot discover anything
   * about the network — it only manufactures "unreachable" verdicts for
   * addresses that may be perfectly good. So this refuses rather than guesses.
   */
  credential: string | undefined;
  /**
   * Bump to measure again with the same inputs.
   *
   * This exists because a re-request for attach info usually — but not
   * necessarily — returns a *different* credential, and "usually" is not a
   * guarantee to hang a user-facing control on: a caller whose reply carried the
   * same credential and the same addresses would find its Re-test silently
   * inert. The bump makes the re-measurement explicit rather than a side effect
   * of what the server chose to mint.
   */
  reprobeKey?: number;
}

export interface AgentProbeController {
  /** The latest measurement for this agent, or null before one lands. */
  probe: AgentProbe | null;
  /** True while a measurement is in flight. */
  probing: boolean;
}

/**
 * Measure an agent's candidate addresses from this browser, and cache where
 * `probeResultsAtom` says cached results live.
 *
 * ## Why this replaced a poll
 *
 * `useProbePolling` did this on a five-minute timer for every online agent,
 * which worked only while the probe was unauthenticated. A credential exists
 * only once an attach reply has arrived (#1013), and it is that reply's own
 * `addresses` the measurement is about — so the measurement belongs wherever
 * the reply is in hand, not on a timer that cannot hold one.
 *
 * ## Why the trigger is a fingerprint and not the array
 *
 * `addresses` is a fresh array on every render of the caller, and the credential
 * is re-minted on every attach-info request. Keying the effect on either
 * identity re-probes on renders that changed nothing; keying it on a string of
 * what the probe actually reads probes exactly when the measurement would
 * differ. The inputs themselves are read through a ref at fire time, which is
 * also what keeps the dependency list honest without disabling the lint.
 */
export function useAgentProbe({ agentId, addresses, credential, reprobeKey = 0 }: AgentProbeInput): AgentProbeController {
  const results = useAtomValue(probeResultsAtom);
  const setResults = useSetAtom(probeResultsAtom);
  const [probing, setProbing] = useState(false);

  // What the probe reads. Held in a ref so the effect below can depend on the
  // fingerprint string alone.
  const inputs = useRef({ agentId, addresses, credential });
  inputs.current = { agentId, addresses, credential };

  /**
   * Which measurement is the current one.
   *
   * A counter rather than a boolean because two probes can overlap — React's
   * StrictMode double-mount, or a re-attach landing while the first is still in
   * flight — and the answer must be "the newest wins", not "the first wins".
   */
  const generation = useRef(0);

  const fingerprint = `${addresses.map((a) => a.url).join('|')}|${credential ?? ''}|${reprobeKey}`;

  useEffect(() => {
    const { agentId: id, addresses: candidates, credential: token } = inputs.current;
    if (!id || !token || candidates.length === 0) {
      setProbing(false);
      return;
    }

    const mine = (generation.current += 1);
    setProbing(true);

    void testAddresses(candidates, { credential: token }).then((latencies) => {
      if (generation.current !== mine) {
        return;
      }
      setProbing(false);
      // Written on total failure too, and that is deliberate: `orderByLatency`
      // never drops a failed address, so "everything failed" is a measurement a
      // reader has to be able to tell from "never measured". Refusing to cache
      // it — which the old poll did — makes an absence do the work of a result,
      // and every reader then renders an untested address as unreachable.
      setResults((previous) => {
        const next = new Map(previous);
        next.set(id, {
          latencies,
          orderedUrls: orderByLatency(latencies),
          probedAt: Date.now(),
        });
        return next;
      });
    });

    // Invalidates this measurement when the fingerprint moves on or the
    // component unmounts, so a late arrival cannot overwrite a newer result.
    return () => {
      generation.current += 1;
    };
    // `inputs` is a ref and the setters are stable; the fingerprint is what
    // decides whether the measurement would differ.
  }, [fingerprint, setResults]);

  return {
    probe: agentId ? (results.get(agentId) ?? null) : null,
    probing,
  };
}
