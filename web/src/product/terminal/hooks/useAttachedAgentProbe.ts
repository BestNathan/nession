// Attached-Agent reachability probing and recovery wakeup (#4618 SC-02/04).
//
// Registers the attached Session's Agent as a probe target so its candidates
// are maintained periodically (not only while the attach dialog is open), and
// wakes the runtime's EXISTING recovery path when a candidate becomes reachable
// while the route is unhealthy. The probe result is a wakeup, never an
// independent attach call: SessionRuntime keeps sole attach authority (#1309).

import { useEffect, useRef } from 'react';
import { probeScheduler, useProbeTargetStates, type ProbeCandidate } from '@/platform/probe';
import type { SessionRuntime, SessionRuntimeSnapshot } from '@/platform/session-runtime/SessionRuntime';
import type { AttachInfo } from '@/types';

export interface AttachedAgentProbeInput {
  runtime: SessionRuntime | null;
  snapshot: SessionRuntimeSnapshot | null;
  attachInfo: AttachInfo | null;
  sessionId: string | null;
}

export function useAttachedAgentProbe({
  runtime,
  snapshot,
  attachInfo,
  sessionId,
}: AttachedAgentProbeInput): void {
  const isP2P = attachInfo?.mode === 'p2p';
  const agentId = isP2P && attachInfo ? attachInfo.session_id.split(':')[0] : null;
  const addresses = isP2P && attachInfo ? (attachInfo.addresses ?? []) : [];
  const fingerprint = addresses.map((a) => `${a.url}|${a.probe_url ?? ''}`).join(',');
  const candidates: ProbeCandidate[] = addresses.map((a) => ({
    addressId: a.url,
    wsUrl: a.url,
    probeUrl: a.probe_url ?? null,
  }));
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;

  // Ref-counted lease for the attached Agent (shares the target with any open
  // attach dialog preview of the same Agent).
  useEffect(() => {
    if (!agentId) {
      return;
    }
    probeScheduler.acquireTarget({ targetId: agentId, kind: 'agent', addresses: [] });
    return () => probeScheduler.releaseTarget(agentId);
  }, [agentId]);

  useEffect(() => {
    const current = candidatesRef.current;
    if (!agentId || current.length === 0) {
      return;
    }
    probeScheduler.registerTarget({ targetId: agentId, kind: 'agent', addresses: current });
  }, [agentId, fingerprint]);

  // Wake recovery when a candidate becomes reachable while the route is not
  // healthy. A healthy attached socket is never preempted by a probe hint.
  const states = useProbeTargetStates(agentId);
  const reachableKey = states
    .filter((s) => s.reachability === 'reachable')
    .map((s) => s.addressId)
    .sort()
    .join(',');
  const previousReachable = useRef(reachableKey);
  useEffect(() => {
    const changed = previousReachable.current !== reachableKey;
    previousReachable.current = reachableKey;
    if (!changed || !runtime || runtime.sessionId !== sessionId || !agentId) {
      return;
    }
    const healthy = snapshot?.phase === 'attached' && snapshot.connectionState === 'connected';
    if (healthy) {
      return; // do not migrate or tear down a healthy route on a probe hint
    }
    if (reachableKey.length > 0) {
      // Existing recovery: connected → liveness question; otherwise reconnect.
      // Generation-safe and single-owner; rotation still walks the plan.
      runtime.resumeOnForeground();
      probeScheduler.noteTransportLoss(agentId);
    }
  }, [reachableKey, runtime, sessionId, agentId, snapshot]);
}
