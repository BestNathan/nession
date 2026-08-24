import type { Session } from '../types';
import type { AttachChoice } from '../components/env/AttachDialog';
import type { WebSocketService } from './websocket';
import type { AgentProbe } from '../atoms/probe';
import { loadAttachPrefs } from './attachPrefs';
import { detectWebGLSupport } from '../terminal/Renderer';

/**
 * Build the same attach choice AttachDialog would produce for Auto mode,
 * without showing the dialog (deep-link / refresh restore).
 */
export async function resolveDeepLinkAttachChoice(
  wsService: WebSocketService,
  session: Session,
  probeResults: Map<string, AgentProbe>,
): Promise<AttachChoice> {
  const prefs = loadAttachPrefs();
  const mode = prefs.mode === 'relay' ? 'auto' : prefs.mode;
  const requestedMode = mode === 'auto' ? 'p2p' : mode;
  const attachInfo = await wsService.requestAttach(session.session_id, requestedMode);
  const cached = probeResults.get(session.agent_id);
  const orderedUrls = cached?.orderedUrls ?? [];
  const latencies = cached?.latencies ?? [];
  const webglSupported = detectWebGLSupport();

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
