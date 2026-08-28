import { useCallback, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useDashboard } from '@/hooks/useDashboard';
import { useSessionFirstAttach } from '@/hooks/useSessionFirstAttach';
import { p2pConnectionAtom } from '@/atoms/connection';
import { sessionIdAtom } from '@/atoms/session';
import { createFileOps } from '@/services/fileOps';
import { mapDomainState } from '@/session-first/domainState';
import type { Surface } from '@/session-first/patterns/SessionHeader';
import type { WorkspaceToolId } from '@/session-first/patterns/WorkspaceNavigation';
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
  const p2pConnection = useAtomValue(p2pConnectionAtom);
  const { attachInFlightId, attachFailedId, attach } = useSessionFirstAttach();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [surface, setSurface] = useState<Surface>('terminal');
  const [tool, setTool] = useState<WorkspaceToolId>('files');
  const [showEnv, setShowEnv] = useState(false);

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
        attachInFlightId,
        attachFailedId,
      })
    : null;

  const fileOps = useMemo(() => {
    const { sendMessage, onMessage, waitForConnection } = p2pConnection ?? {};
    return sendMessage && onMessage && waitForConnection
      ? createFileOps({ sendMessage, onMessage, waitForConnection })
      : null;
  }, [p2pConnection]);

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
    void attach(s);
  }, [attach]);

  return {
    data,
    selectedId,
    surface,
    tool,
    showEnv,
    setShowEnv,
    selectedSession,
    selectedAgent,
    domain,
    fileOps,
    clientSessionId,
    attachInFlightId,
    attachFailedId,
    onKilled,
    handleSelect,
    setSurface,
    setTool,
  };
}
