import type { Session } from '../types';
import type { AttachChoice } from '../components/env/AttachDialog';
import { sessionsApi } from '../features/sessions';
import type { AgentProbe } from '../atoms/probe';
import { loadAttachPrefs } from './attachPrefs';
import { detectWebGLSupport } from '../terminal/Renderer';
import { orderByLatency, testAddresses } from './addressSelection';

/**
 * Build the same attach choice AttachDialog would produce for Auto mode,
 * without showing the dialog (deep-link / refresh restore).
 */
export async function resolveDeepLinkAttachChoice(
  session: Session,
  probeResults: Map<string, AgentProbe>,
): Promise<AttachChoice> {
  const prefs = loadAttachPrefs();
  const mode = prefs.mode === 'relay' ? 'auto' : prefs.mode;
  const requestedMode = mode === 'auto' ? 'p2p' : mode;
  const attachInfo = await sessionsApi.requestAttach(session.session_id, requestedMode);
  const cached = probeResults.get(session.agent_id);
  let orderedUrls = cached?.orderedUrls ?? [];
  let latencies = cached?.latencies ?? [];
  const webglSupported = detectWebGLSupport();

  if (orderedUrls.length === 0 && attachInfo.mode === 'p2p') {
    const candidates = attachInfo.addresses ?? [];
    if (candidates.length > 0) {
      const results = await testAddresses(candidates);
      latencies = results;
      orderedUrls = orderByLatency(results);
    } else if (attachInfo.agent_address) {
      orderedUrls = [attachInfo.agent_address];
    }
  }

  return {
    mode,
    attachInfo,
    orderedUrls,
    latencies,
    selectedUrl: null,
    relayUrl: null,
    renderer: webglSupported ? prefs.renderer : 'canvas',
    envRefs: [],
  };
}
