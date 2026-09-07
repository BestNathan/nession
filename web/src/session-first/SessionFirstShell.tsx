import { Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useProbePolling } from '@/hooks/useProbePolling';
import { SessionFirstDialogs } from '@/session-first/SessionFirstDialogs';
import { SessionFirstWorkspace } from '@/session-first/SessionFirstWorkspace';
import { useSessionFirstShellState } from '@/session-first/useSessionFirstShellState';
import type { ConnectionState } from '@/services/socket';

export interface SessionFirstShellProps {
  connectionStatus: ConnectionState;
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

  return (
    <>
      <div
        data-testid="session-first-shell"
        data-sf-design="polish"
        className="session-first-shell flex h-[100dvh] flex-col bg-background"
      >
        {data.error ? (
          <div
            data-testid="session-first-error"
            className="flex shrink-0 items-center gap-2 bg-destructive/10 px-3 py-2 text-destructive text-sm"
          >
            <span className="min-w-0 flex-1">{data.error}</span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-5"
                    aria-label="Dismiss error"
                    onClick={() => data.clearError()}
                  />
                }
              >
                <X className="size-3" />
              </TooltipTrigger>
              <TooltipContent side="bottom">Dismiss</TooltipContent>
            </Tooltip>
          </div>
        ) : null}
        {state.isRestoringDeepLink ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
            <Loader2 className="size-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Restoring terminal session…</p>
          </div>
        ) : (
          <SessionFirstWorkspace
            connectionStatus={connectionStatus}
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
            isWide={state.isWide}
            showList={state.showList}
            showDetail={state.showDetail}
            onBackToSessions={state.openList}
            onLegacy={onLegacy}
          />
        )}
      </div>
      {dialogs}
    </>
  );
}
