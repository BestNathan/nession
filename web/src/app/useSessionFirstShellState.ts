import { useCallback, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { toast } from 'sonner';
import { useDashboard } from '@/app/useDashboard';
import { useSessionFirstAttach } from '@/app/useSessionFirstAttach';
import { useSessionFirstDeepLink } from '@/app/useSessionFirstDeepLink';
import { useSessionFirstMobileNav } from '@/app/useSessionFirstMobileNav';
import { useSessionRuntime } from '@/features/terminal/hooks/useSessionRuntime';
import { useWebSocket } from '@/shared/hooks/useWebSocket';
import { relayServerHandle } from '@/runtime/relayServerConnection';
import { attachDialogIntentAtom, sessionIdAtom } from '@/atoms/session';
import { persistConfirmedChoice } from '@/services/sessionAttachProfile';
import { mapDomainState } from '@/features/sessions/model/domainState';
import type { AttachChoice } from '@/features/sessions/components/AttachDialog';
import type { Surface } from '@/app/patterns/SessionHeader';
import type { WorkspaceToolId } from '@/app/workspace/toolTypes';
import type { Session } from '@/types';

export function useSessionFirstShellState() {
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
  const serverConnection = useMemo(() => relayServerHandle(wsService), [wsService]);
  const { fileOps } = useSessionRuntime({ serverConnection });
  const {
    attachDialogSession,
    requestAttach,
    confirmAttach,
    cancelAttach,
    openAttachSettings,
  } = useSessionFirstAttach();
  const attachDialogIntent = useAtomValue(attachDialogIntentAtom);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [surface, setSurface] = useState<Surface>('terminal');
  const [tool, setTool] = useState<WorkspaceToolId>('files');
  const { isWide, showList, showDetail, openDetail, openList } =
    useSessionFirstMobileNav(selectedId);

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
    toast('Attach settings saved — applies to the next attach');
  }, [cancelAttach]);

  const { isRestoringDeepLink } = useSessionFirstDeepLink({
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
    setSurface,
    setTool,
    isRestoringDeepLink,
    isWide,
    showList,
    showDetail,
    openList,
  };
}
