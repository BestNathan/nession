import { useCallback } from 'react';
import { Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ShellDialogs } from '@/app/ShellDialogs';
import { WorkspaceRegion } from '@/app/WorkspaceRegion';
import { useShellState } from '@/app/useShellState';
import type { ConnectionState } from '@/platform/socket';

export interface ShellProps {
  connectionStatus: ConnectionState;
}

export function Shell({ connectionStatus }: ShellProps) {
  const state = useShellState();
  const { data } = state;

  // Creating and selecting are two hooks' jobs, so they are composed here
  // rather than one reaching into the other's state (#1082): the dashboard
  // refreshes its lists, the shell state waits for the new Session to appear
  // and then selects it down the ordinary path.
  const handleSessionCreated = useCallback(
    (sessionId?: string) => {
      data.handleSessionCreated();
      state.awaitSession(sessionId);
    },
    [data, state],
  );

  const dialogs = (
    <ShellDialogs
      showCreateModal={data.showCreateModal}
      setShowCreateModal={data.setShowCreateModal}
      agents={data.agents}
      handleSessionCreated={handleSessionCreated}
      sessionToKill={data.sessionToKill}
      setSessionToKill={data.setSessionToKill}
      onKilled={state.onKilled}
      attachDialogSession={state.attachDialogSession}
      attachDialogIntent={state.attachDialogIntent}
      onAttachConfirm={state.confirmAttach}
      onConfigureConfirm={state.saveAttachSettings}
      onAttachClose={state.cancelAttach}
    />
  );

  return (
    <>
      <div
        data-testid="shell"
        data-sf-design="polish"
        className="shell flex h-[100dvh] flex-col bg-background"
      >
        {data.error ? (
          <div
            data-testid="shell-error"
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
          <WorkspaceRegion
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
            onConfigure={state.openAttachSettings}
            onKill={(s) => data.setSessionToKill(s)}
            onSurfaceChange={state.setSurface}
            onToolChange={state.setTool}
            isWide={state.isWide}
            showList={state.showList}
            showDetail={state.showDetail}
            onBackToSessions={state.openList}
            onCloseDrawer={state.openDetail}
          />
        )}
      </div>
      {dialogs}
    </>
  );
}
