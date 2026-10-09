import { useCallback, useMemo, useState } from 'react';
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
import { useOpenWorktreeSession } from '@/app/useOpenWorktreeSession';
import { sessionFromCreateAck } from '@/product/session/model/sessionFromCreateAck';

/**
 * Make the Session a create ACK names current (#1430), without waiting for the
 * sessions projection to echo the id back — `sessionFromCreateAck` carries the
 * why. The optimistic insert is what `selectedSession` resolves against until
 * the server's own row arrives with the same id.
 */
function createdSessionSelection(
  sessionId: string | undefined,
  insertSession: (session: Session) => void,
  select: (session: Session) => void,
): void {
  if (!sessionId) {
    return;
  }
  const created = sessionFromCreateAck(sessionId);
  insertSession(created);
  select(created);
}

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

  const selectSessionInWorkspace = useCallback((s: Session) => {
    setSelectedId(s.session_id);
    setSurface('workspace');
    setTool('git');
    openDetail();
  }, [openDetail]);

  const handleOpenWorktreeSession = useOpenWorktreeSession({
    agentId: selectedAgent?.agent_id,
    selectSessionInWorkspace,
  });

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

  /** Create ACK → current Session, without a wait on the sessions projection. */
  const selectCreatedSession = useCallback(
    (sessionId: string | undefined) =>
      createdSessionSelection(sessionId, data.insertSession, handleSelect),
    [data, handleSelect],
  );

  const { isRestoringDeepLink } = useDeepLink({
    sessions,
    sessionsLoaded: data.sessionsLoaded,
    loadingSessions: data.loadingSessions,
    confirmAttach,
    onRestoreSession,
    requestAttach,
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
    selectCreatedSession,
    handleOpenWorktreeSession,
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
