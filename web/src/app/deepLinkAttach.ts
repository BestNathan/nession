import type { AddressLatency, AttachInfo, Session } from '@/types';
import type { AttachChoice } from '@/product/session/components/AttachDialog';
import { sessionsApi } from '@/product/session';
import type { AgentProbe } from '@/product/agent/state';
import { loadAttachPrefs } from '@/platform/attach/attachPrefs';
import { detectWebGLSupport } from '@/platform/terminal-runtime/Renderer';
import {
  validateProfile,
  type PersistedAttachChoice,
  type SessionAttachProfile,
} from '@/platform/attach/sessionAttachProfile';

/** Requested transport for a stored mode: 'auto' fetches p2p attach info. */
function requestedModeOf(mode: PersistedAttachChoice['mode']): 'p2p' | 'relay' {
  return mode === 'auto' ? 'p2p' : mode;
}

/** Manual relay endpoint to scope the request, for relay targets only. */
function relayOverrideOf(choice: PersistedAttachChoice): string | undefined {
  return choice.mode === 'relay' && choice.selectedUrl !== null
    ? choice.selectedUrl
    : undefined;
}

async function fetchAttachInfo(
  session: Session,
  choice: PersistedAttachChoice,
): Promise<AttachInfo> {
  const requestedMode = requestedModeOf(choice.mode);
  const relayUrl = relayOverrideOf(choice);
  // Pass relayUrl only when present: requestAttach defaults it, and callers
  // observe the exact call arity (no trailing undefined for p2p targets).
  return relayUrl === undefined
    ? sessionsApi.requestAttach(session.session_id, requestedMode)
    : sessionsApi.requestAttach(session.session_id, requestedMode, relayUrl);
}

/**
 * Candidate URL ordering (#1430): the probe cache when it exists, otherwise the
 * advertisement's own order — never a wait for the browser's measurement.
 *
 * The agent priority-sorts its advertised addresses (`crates/nession-common/
 * src/address.rs`: de-duplicate, then a stable sort by priority), so on a cold
 * cache the first entry is the right first attempt. Measuring the others is
 * still worth doing and still happens — `useAgentProbe` owns it from the
 * attach reply's credential and caches it for the next attach — but gating the
 * first attempt on it put the slowest candidate, up to the 3s handshake
 * deadline, inside the create → attach critical path.
 *
 * Latencies are the cache's when there is one and empty otherwise; the dialog
 * column that displays them has its own measurement path.
 */
function resolveOrdering(
  info: AttachInfo,
  probe: AgentProbe | undefined,
): { orderedUrls: string[]; latencies: AddressLatency[] } {
  const cachedUrls = probe?.orderedUrls ?? [];
  const cachedLatencies = probe?.latencies ?? [];
  if (cachedUrls.length > 0 || info.mode !== 'p2p') {
    return { orderedUrls: cachedUrls, latencies: cachedLatencies };
  }
  const candidates = info.addresses ?? [];
  if (candidates.length === 0) {
    return { orderedUrls: info.agent_address ? [info.agent_address] : [], latencies: cachedLatencies };
  }
  return {
    orderedUrls: candidates.map((candidate) => candidate.url),
    latencies: cachedLatencies,
  };
}

function buildChoice(
  choice: PersistedAttachChoice,
  info: AttachInfo,
  orderedUrls: string[],
  latencies: AddressLatency[],
): AttachChoice {
  return {
    mode: choice.mode,
    attachInfo: info,
    orderedUrls,
    latencies,
    selectedUrl: choice.selectedUrl,
    relayUrl: choice.mode === 'relay' ? choice.selectedUrl : null,
    renderer: detectWebGLSupport() ? choice.renderer : 'canvas',
    envRefs: choice.envRefs,
  };
}

/**
 * Build the AttachChoice the dialog would produce for a persisted target,
 * without showing the dialog. `attachInfo` may be supplied when it was
 * already fetched (e.g. for validation) to avoid a second request.
 */
export async function resolveTargetChoice(
  session: Session,
  choice: PersistedAttachChoice,
  probeResults: Map<string, AgentProbe>,
  attachInfo?: AttachInfo,
): Promise<AttachChoice> {
  const info = attachInfo ?? (await fetchAttachInfo(session, choice));
  const probe = probeResults.get(session.agent_id);
  const { orderedUrls, latencies } = resolveOrdering(info, probe);
  return buildChoice(choice, info, orderedUrls, latencies);
}

/** Attach resolution for a saved profile on restore / row fast-path. */
export type ProfileAttachResolution =
  | { kind: 'choice'; choice: AttachChoice }
  | { kind: 'dialog' }
  | { kind: 'failed'; error: string };

function attachResolutionError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to resolve attach';
}

export async function resolveProfileAttach(
  session: Session,
  profile: SessionAttachProfile,
  probeResults: Map<string, AgentProbe>,
): Promise<ProfileAttachResolution> {
  try {
    const info = await fetchAttachInfo(session, profile.choice);
    if (!validateProfile(profile, info).ok) {
      return { kind: 'dialog' };
    }
    const choice = await resolveTargetChoice(session, profile.choice, probeResults, info);
    return { kind: 'choice', choice };
  } catch (error) {
    return { kind: 'failed', error: attachResolutionError(error) };
  }
}

/**
 * Legacy dialog-less path for deep-link / refresh restore with no per-session
 * profile: resolve the same auto-mode choice AttachDialog would produce from
 * the global attach prefs. Stored relay maps to auto (legacy semantics).
 */
export async function resolveDeepLinkAttachChoice(
  session: Session,
  probeResults: Map<string, AgentProbe>,
): Promise<AttachChoice> {
  const prefs = loadAttachPrefs();
  const target: PersistedAttachChoice = {
    mode: prefs.mode === 'relay' ? 'auto' : prefs.mode,
    renderer: prefs.renderer,
    envRefs: [],
    selectedUrl: null,
  };
  return resolveTargetChoice(session, target, probeResults);
}
