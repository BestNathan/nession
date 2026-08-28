import { Loader2 } from 'lucide-react';
import { EnvManager } from '@/components/env/EnvManager';
import { useProbePolling } from '@/hooks/useProbePolling';
import { SessionFirstChrome } from '@/session-first/SessionFirstChrome';
import { SessionFirstDialogs } from '@/session-first/SessionFirstDialogs';
import { SessionFirstWorkspace } from '@/session-first/SessionFirstWorkspace';
import { useSessionFirstShellState } from '@/session-first/useSessionFirstShellState';
import type { ConnectionStatus } from '@/types';

export interface SessionFirstShellProps {
  connectionStatus: ConnectionStatus;
  onLegacy: () => void;
}

export function SessionFirstShell({ connectionStatus, onLegacy }: SessionFirstShellProps) {
  const state = useSessionFirstShellState();
  const { data } = state;
  useProbePolling(data.agents);

  const dialogs = (
    <SessionFirstDialogs
      showCreateModal={data.showCreateModal}
      setShowCreateModal={data.setShowCreateModal}
      agents={data.agents}
      handleSessionCreated={data.handleSessionCreated}
      sessionToKill={data.sessionToKill}
      setSessionToKill={data.setSessionToKill}
      onKilled={state.onKilled}
      attachDialogSession={state.attachDialogSession}
      onAttachConfirm={state.confirmAttach}
      onAttachClose={state.cancelAttach}
    />
  );

  if (state.showEnv) {
    return (
      <>
        <div
          data-testid="session-first-shell"
          className="session-first-shell flex h-[100dvh] flex-col bg-background"
        >
          <EnvManager agents={data.agents} onBack={() => state.setShowEnv(false)} />
        </div>
        {dialogs}
      </>
    );
  }

  return (
    <>
      <div
        data-testid="session-first-shell"
        className="session-first-shell flex h-[100dvh] flex-col bg-background"
      >
        <SessionFirstChrome
          connectionStatus={connectionStatus}
          error={data.error}
          clearError={data.clearError}
        />
        {state.isRestoringDeepLink ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
            <Loader2 className="size-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Restoring terminal session…</p>
          </div>
        ) : (
          <SessionFirstWorkspace
            agents={data.agents}
            filteredSessions={data.filteredSessions}
            staleAgents={data.staleAgents}
            selectedId={state.selectedId}
            clientSessionId={state.clientSessionId}
            loadingSessions={data.loadingSessions}
            searchQuery={data.searchQuery}
            setSearchQuery={data.setSearchQuery}
            statusFilter={data.statusFilter}
            setStatusFilter={data.setStatusFilter}
            sortField={data.sortField}
            sortDirection={data.sortDirection}
            toggleSort={data.toggleSort}
            isSearchActive={data.isSearchActive}
            selectedSession={state.selectedSession}
            selectedAgent={state.selectedAgent}
            domain={state.domain}
            surface={state.surface}
            tool={state.tool}
            fileOps={state.fileOps}
            onCreate={() => data.setShowCreateModal(true)}
            onRefresh={() => { void data.fetchSessions({ force: true }); }}
            onSelect={state.handleSelect}
            onKill={(s) => data.setSessionToKill(s)}
            onSurfaceChange={state.setSurface}
            onToolChange={state.setTool}
            onOpenAgent={() => {
              state.setSurface('workspace');
              state.setTool('agent');
            }}
            showList={state.showList}
            showDetail={state.showDetail}
            onBackToSessions={state.openList}
            onOpenEnv={() => state.setShowEnv(true)}
            onLegacy={onLegacy}
          />
        )}
      </div>
      {dialogs}
    </>
  );
}
