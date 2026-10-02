/**
 * Test helper: lease a SessionRuntime in the registry, driven to a given
 * attach phase, for consumers that read the phase back through
 * `sessionRuntimeRegistry` (#1309: the runtime is the phase's only owner, so
 * a test that needs "the terminal is failed" must put a runtime there — the
 * deleted mirror atom can no longer be set instead).
 *
 * The config is inert on purpose: relay intent with no attach info and no
 * server connection, so construction dispatches SESSION_SELECTED and nothing
 * connects. The phase is then driven by dispatching on the runtime's own
 * controller — the same public surface the tests of the runtime itself use.
 *
 * Returns the release function; call it in afterEach so the lease cannot
 * leak into the next test.
 */
import type { SessionRuntimeConfig } from '@/platform/session-runtime/SessionRuntime';
import { sessionRuntimeRegistry } from '@/platform/session-runtime/SessionRuntimeRegistry';

export function leaseRuntimeAtPhase(sessionId: string, phase: 'attached' | 'failed'): () => void {
  const config: SessionRuntimeConfig = {
    sessionId,
    sessionName: sessionId,
    attachInfo: null,
    orderedUrls: null,
    manualOverride: null,
    forcedRelay: true,
    addressPlan: { urls: [], ready: true },
    routeIntentEpoch: 0,
    // Never called: the inert context (no attachInfo, relay intent, no server
    // connection) keeps the runtime from building any transport or agent API.
    createFilesApi: () => { throw new Error('inert runtime builds no files api'); },
    createTerminalAgentApi: () => { throw new Error('inert runtime builds no agent api'); },
    createTransport: () => { throw new Error('inert runtime builds no transport'); },
  };
  const lease = sessionRuntimeRegistry.acquire(sessionId, config);
  // Construction already dispatched SESSION_SELECTED → 'connecting' (#1309 SC-01).
  if (phase === 'attached') {
    lease.runtime.attachController.dispatch({ type: 'ATTACH_OK' });
  } else {
    lease.runtime.attachController.dispatch({ type: 'TRANSPORT_EXHAUSTED', manualRoute: true });
  }
  return () => lease.release();
}
