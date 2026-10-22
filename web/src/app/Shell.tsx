import { useCallback, useState } from 'react';
import { Bot, Loader2, X } from 'lucide-react';
import { AIExperience } from '@/app/experiences/ai/AIExperience';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ShellDialogs } from '@/app/ShellDialogs';
import { WorkspaceRegion } from '@/app/WorkspaceRegion';
import { useShellState } from '@/app/useShellState';
import type { ConnectionState } from '@/platform/socket';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';

export interface ShellProps {
  connectionStatus: ConnectionState;
  onRetry?: () => void;
}

export function Shell({ connectionStatus, onRetry }: ShellProps) {
  const state = useShellState();
  const { data } = state;
  const [mode, setMode] = useState<'standard' | 'ai'>('standard');
  const [preselectedAgentId, setPreselectedAgentId] = useState<string | null>(null);
  const openCreateSession = useCallback((agentId?: string) => {
    setPreselectedAgentId(agentId ?? null);
    data.setShowCreateModal(true);
  }, [data]);

  // Creating and selecting are two hooks' jobs, so they are composed here
  // rather than one reaching into the other's state (#1082): the dashboard
  // refreshes its lists, and the shell state makes the created Session current
  // from the dialog's own id — `#1430` removed the wait for that refresh, so
  // the two now run beside each other rather than in sequence. The refresh
  // stays: it is what reconciles the row with the server's own.
  const handleSessionCreated = useCallback(
    (sessionId?: string) => {
      data.handleSessionCreated();
      state.selectCreatedSession(sessionId);
      setMode('standard');
    },
    [data, state],
  );

  const dialogs = (
    <ShellDialogs
      showCreateModal={data.showCreateModal}
      createPreselectedAgentId={preselectedAgentId}
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
            className={cn('flex shrink-0 items-center gap-2 bg-destructive/10 px-3 py-2 text-destructive', chromeSansRole('body'))}
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
        {connectionStatus === 'disconnected' && onRetry ? (
          <div role="status" className="flex shrink-0 items-center justify-center gap-2 px-3 py-1 text-muted-foreground">
            <span className={chromeSansRole('secondary')}>Connection unavailable</span>
            <Button type="button" size="sm" variant="ghost" onClick={onRetry}>Retry</Button>
          </div>
        ) : null}
        <div className="flex shrink-0 items-center justify-between border-b px-3 py-2 sm:px-5" data-testid="shell-mode-bar">
          <span className="flex items-center gap-2 text-sm font-medium"><Bot className="size-4" aria-hidden /> Nession</span>
          <div className="flex items-center gap-1 rounded-lg bg-muted p-1" role="group" aria-label="Interface mode">
            <Button type="button" size="sm" variant={mode === 'standard' ? 'secondary' : 'ghost'} aria-pressed={mode === 'standard'} onClick={() => setMode('standard')}>Standard</Button>
            <Button type="button" size="sm" variant={mode === 'ai' ? 'secondary' : 'ghost'} aria-pressed={mode === 'ai'} onClick={() => setMode('ai')}>AI</Button>
          </div>
        </div>
        {state.isRestoringDeepLink ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
            <Loader2 className="size-8 animate-spin text-muted-foreground" />
            <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>Restoring terminal session…</p>
          </div>
        ) : (
          <div className="relative flex min-h-0 flex-1">
            {/* Keep the existing work surface mounted, including its Terminal runtime,
                while AI mode takes focus. Visibility preserves layout measurements. */}
            <div
              className={cn('absolute inset-0 flex min-h-0', mode === 'ai' && 'invisible pointer-events-none')}
              inert={mode === 'ai'}
              aria-hidden={mode === 'ai'}
            >
          <WorkspaceRegion
            connectionStatus={connectionStatus}
            agents={data.agents}
            filteredSessions={data.filteredSessions}
            totalSessionCount={data.sessions.length}
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
            onCreate={() => openCreateSession()}
            onRefresh={() => { void data.fetchSessions({ force: true }); }}
            onSelect={state.handleSelect}
            onOpenWorktreeSession={state.handleOpenWorktreeSession}
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
            </div>
            {mode === 'ai' ? (
              <AIExperience
                agents={data.agents}
                sessions={data.sessions}
                onCreateSession={openCreateSession}
                onOpenSession={(session) => { state.handleSelect(session); setMode('standard'); }}
              />
            ) : null}
          </div>
        )}
      </div>
      {dialogs}
    </>
  );
}
