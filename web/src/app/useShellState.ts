import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { toast } from 'sonner';
import { useDashboard } from '@/app/useDashboard';
import { useAttachFlow } from '@/app/useAttachFlow';
import { useDeepLink } from '@/app/useDeepLink';
import { useMobileNav } from '@/app/useMobileNav';
import { useSessionRuntime } from '@/product/terminal/hooks/useSessionRuntime';
import { useWebSocket } from '@/shared/hooks/useWebSocket';
import { relayServerHandle } from '@/platform/attach/relayServerConnection';
import { attachDialogIntentAtom, sessionIdAtom } from '@/product/session/state';
import { persistConfirmedChoice } from '@/platform/attach/sessionAttachProfile';
import { terminalServerApi } from '@/product/terminal';
import { mapDomainState } from '@/product/session/model/domainState';
import type { AttachChoice } from '@/product/session/components/AttachDialog';
import type { Surface } from '@/app/patterns/SessionHeader';
import type { CapabilityId } from '@/product/capability';
import type { Session } from '@/types';

export function useShellState() {
  const data = useDashboard();
  const {
    agents,
    sessions,
    staleAgents,
    sessionToKill,
    handleSessionKilled,
  } = data;
  const clientSessionId = useAtomValue(sessionIdAtom);
  const wsService = useWebSocket();
  // The runtime takes a narrow relay handle, never the transport itself.
  const serverConnection = useMemo(() => relayServerHandle(wsService, terminalServerApi), [wsService]);
  const { fileOps } = useSessionRuntime({ serverConnection });
  const {
    attachDialogSession,
    requestAttach,
    confirmAttach,
    cancelAttach,
    openAttachSettings,
  } = useAttachFlow();
  const attachDialogIntent = useAtomValue(attachDialogIntentAtom);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [surface, setSurface] = useState<Surface>('terminal');
  const [tool, setTool] = useState<CapabilityId>('files');
  const { isWide, showList, showDetail, openDetail, openList } =
    useMobileNav(selectedId);

  const selectedSession = selectedId
    ? sessions.find((session) => session.session_id === selectedId) ?? null
    : null;
  const selectedAgent = selectedSession
    ? agents.find((a) => a.agent_id === selectedSession.agent_id) ?? undefined
    : undefined;
  const domain = selectedSession
    ? mapDomainState({
        session: selectedSession,
        agent: selectedAgent,
        staleAgentIds: staleAgents,
        clientSessionId,
        attachInFlightId: null,
        attachFailedId: null,
      })
    : null;

  const onKilled = useCallback(() => {
    if (sessionToKill?.session_id === selectedId) {
      setSelectedId(null);
    }
    handleSessionKilled();
  }, [sessionToKill, handleSessionKilled, selectedId]);

  const handleSelect = useCallback((s: Session) => {
    setSelectedId(s.session_id);
    setSurface('terminal');
    setTool('files');
    openDetail();
    requestAttach(s);
  }, [openDetail, requestAttach]);

  const onRestoreSession = useCallback((s: Session) => {
    setSelectedId(s.session_id);
    setSurface('terminal');
    setTool('files');
    openDetail();
  }, [openDetail]);

  /** Settings Save: persist the profile only — never attach or reconnect. */
  const saveAttachSettings = useCallback((session: Session, choice: AttachChoice) => {
    persistConfirmedChoice(session, choice, choice.attachInfo);
    cancelAttach();
    toast.success('Attach settings saved — applies to the next attach');
  }, [cancelAttach]);

  // A Session that was just created, waiting for the refreshed list to carry
  // it (#1082). Held as an **id**, not a name or a position: the list arrives
  // from a separate request, and picking "the newest row" or "the one with this
  // name" would select a different Session whenever the guess is wrong.
  const [awaitingSessionId, setAwaitingSessionId] = useState<string | null>(null);

  const awaitSession = useCallback((sessionId: string | undefined) => {
    setAwaitingSessionId(sessionId ?? null);
  }, []);

  useEffect(() => {
    if (awaitingSessionId === null) {
      return;
    }
    const created = sessions.find((s) => s.session_id === awaitingSessionId);
    if (!created) {
      // Still absent — the refresh has not landed. Kept rather than cleared so
      // the next list selects it; the home stays usable meanwhile.
      return;
    }
    setAwaitingSessionId(null);
    // The ordinary selection path, so creating enters the same attach flow as
    // choosing a row. Nothing here is specific to having just created it.
    handleSelect(created);
  }, [awaitingSessionId, sessions, handleSelect]);

  const { isRestoringDeepLink } = useDeepLink({
    sessions,
    sessionsLoaded: data.sessionsLoaded,
    loadingSessions: data.loadingSessions,
    confirmAttach,
    onRestoreSession,
  });

  return {
    data,
    selectedId,
    surface,
    tool,
    selectedSession,
    selectedAgent,
    domain,
    fileOps,
    clientSessionId,
    attachDialogSession,
    attachDialogIntent,
    requestAttach,
    confirmAttach,
    cancelAttach,
    openAttachSettings,
    saveAttachSettings,
    onKilled,
    handleSelect,
    awaitSession,
    setSurface,
    setTool,
    isRestoringDeepLink,
    isWide,
    showList,
    showDetail,
    openList,
    openDetail,
  };
}
