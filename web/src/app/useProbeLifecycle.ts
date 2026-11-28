// App composition for the reachability probe service (#4618).
//
// The scheduler owns the background task; this hook only wires the app's
// lifecycle facts into it: start the network observation once, apply the
// configured periodic interval, register the active Server target while
// authenticated, and wake probing on a real transport loss. It never decides
// routes or attaches a Session — the Server connection owner keeps doing that.

import { useEffect, useRef } from 'react';
import { deriveProbeUrl, loadProbePrefs, probeScheduler } from '@/platform/probe';
import type { ConnectionState } from '@/platform/socket/types';

/** The logical Server probe target identity (one configured origin). */
export const SERVER_PROBE_TARGET_ID = 'server';

export interface ProbeLifecycleInput {
  wasEverAuthed: boolean;
  isAuthenticated: boolean;
  serverUrl: string;
  connectionStatus: ConnectionState;
}

export function useProbeLifecycle({
  wasEverAuthed,
  isAuthenticated,
  serverUrl,
  connectionStatus,
}: ProbeLifecycleInput): void {
  // Start network observation once and apply the persisted periodic interval.
  useEffect(() => {
    probeScheduler.start();
    probeScheduler.setIntervalMs(loadProbePrefs().intervalMs);
  }, []);

  // Register the active Server target only while authenticated. The probe URL
  // is derived from the explicitly configured/trusted Server origin — never a
  // discovered host. Releasing on logout stops its periodic work.
  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    const probeUrl = deriveProbeUrl(serverUrl);
    if (!probeUrl) {
      return;
    }
    probeScheduler.acquireTarget({
      targetId: SERVER_PROBE_TARGET_ID,
      kind: 'server',
      addresses: [{ addressId: serverUrl, wsUrl: serverUrl, probeUrl }],
    });
    return () => probeScheduler.releaseTarget(SERVER_PROBE_TARGET_ID);
  }, [isAuthenticated, serverUrl]);

  // A real transport loss wakes recovery probing. A probe success never clears
  // the WS failure budget or retires a healthy route — that authority stays
  // with the transport and the connection owner.
  const wasConnected = useRef(false);
  useEffect(() => {
    const connected = connectionStatus === 'connected';
    if (wasConnected.current && !connected && wasEverAuthed) {
      probeScheduler.noteTransportLoss(SERVER_PROBE_TARGET_ID);
    }
    wasConnected.current = connected;
  }, [connectionStatus, wasEverAuthed]);
}
