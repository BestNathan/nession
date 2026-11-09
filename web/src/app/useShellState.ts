import { useCallback, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useDashboard } from '@/app/useDashboard';
import { useAttachFlow } from '@/app/useAttachFlow';
import { useDeepLink } from '@/app/useDeepLink';
import { useMobileNav } from '@/app/useMobileNav';
import { useSessionRuntime } from '@/product/terminal/hooks/useSessionRuntime';
import { useWebSocket } from '@/shared/hooks/useWebSocket';
import { relayServerHandle } from '@/platform/attach/relayServerConnection';
import { attachDialogIntentAtom, sessionIdAtom } from '@/product/session/state';
import { terminalServerApi } from '@/product/terminal';
import type { Surface } from '@/app/patterns/SessionHeader';
import type { CapabilityId } from '@/product/capability';
import type { Session } from '@/types';
import { useOpenWorktreeSession } from '@/app/useOpenWorktreeSession';
import { useAttachSettingsPersistence, useProjectSelection } from '@/app/useShellSelections';
import { useSelectedSession } from '@/app/useSelectedSession';
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

/**
 * The two ways a Session can become current.
 *
 * `restore` is a navigation (deep link, confirmed attach) and returns to the
 * Terminal. `sync` only keeps the shell's selection in step with a Sessions
 * projection push — a foreground command, an attached-client count, another
 * Session appearing — so it must leave the user's surface alone: restoring the
 * same selection is not a route change.
 */
function useSessionSelectionCommands(commands: {
  setSelectedId: (sessionId: string) => void;
  setSurface: (surface: Surface) => void;
  setTool: (tool: CapabilityId) => void;
  openDetail: () => void;
  clearProject: () => void;
}) {
  const { setSelectedId, setSurface, setTool, openDetail, clearProject } = commands;
  const restore = useCallback((s: Session) => {
    clearProject();
    setSelectedId(s.session_id);
    setSurface('terminal');
    setTool('files');
    openDetail();
  }, [clearProject, openDetail, setSelectedId, setSurface, setTool]);
  const sync = useCallback((s: Session) => {
    setSelectedId(s.session_id);
    openDetail();
  }, [openDetail, setSelectedId]);
  return { restore, sync };
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
  const {
    selectedProjectId,
    selectProject: handleSelectProject,
    closeProject: handleCloseProject,
  } = useProjectSelection();
  const [surface, setSurface] = useState<Surface>('terminal');
  const [tool, setTool] = useState<CapabilityId>('files');
  const { isWide, showList, showDetail, openDetail, openList } =
    useMobileNav(selectedId);

  const { selectedSession, selectedAgent, domain } = useSelectedSession({
    sessions,
    agents,
    selectedId,
    staleAgents,
    clientSessionId,
  });

  const onKilled = useCallback(() => {
    if (sessionToKill?.session_id === selectedId) {
      setSelectedId(null);
    }
    handleSessionKilled();
  }, [sessionToKill, handleSessionKilled, selectedId]);

  const handleSelect = useCallback((s: Session) => {
    setSelectedId(s.session_id);
    handleCloseProject();
    setSurface('terminal');
    setTool('files');
    openDetail();
    requestAttach(s);
  }, [handleCloseProject, openDetail, requestAttach]);

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

  const { restore: onRestoreSession, sync: syncSelectedSession } =
    useSessionSelectionCommands({
      setSelectedId,
      setSurface,
      setTool,
      openDetail,
      clearProject: handleCloseProject,
    });

  /** Settings Save: persist the profile only — never attach or reconnect. */
  const saveAttachSettings = useAttachSettingsPersistence(cancelAttach);

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
    onSyncSessionSelection: syncSelectedSession,
    requestAttach,
  });

  return {
    data,
    selectedId,
    selectedProjectId,
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
    handleSelectProject,
    handleCloseProject,
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
