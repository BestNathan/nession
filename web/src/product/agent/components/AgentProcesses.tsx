import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RefreshButton } from '@/components/ui/RefreshButton';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/shared/lib/utils';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import type { Agent } from '@/types';
import type { ProcessSnapshot } from '@/product/agent/types';
import {
  coverageLabel,
  formatSnapshotTime,
  methodLabel,
  processKey,
  reasonLabel,
} from '@/product/agent/model/processSnapshot';
import { useAgentProcesses, type AgentProcessesState } from '@/product/agent/hooks/useAgentProcesses';
import { ProcessTree, type SelectedProcess } from './ProcessTree';
import { ProcessInspector } from './ProcessInspector';

export interface AgentProcessesProps {
  agent: Agent;
  /** The Session the Workspace was opened from, when it belongs to `agent`. */
  currentSessionId?: string | null;
}

/**
 * Contextual Sessions & Processes section of AgentDetail (#2514).
 *
 * This is deeper detail on one already-open Agent, not a permanent Process
 * tab: it sits inside the existing Agent Workspace capability, keeps the node
 * identity above it, and never becomes a navigation parent for Sessions.
 */
export function AgentProcesses({ agent, currentSessionId }: AgentProcessesProps) {
  const view = useAgentProcesses(agent, currentSessionId);
  const [selection, setSelection] = useState<SelectedProcess | null>(null);

  // Keep a selected process across a refresh only while the new snapshot still
  // contains the same PID + start time at the same Pane. A selection that
  // vanished is dropped rather than re-pointed at a reused PID.
  const selected = useMemo(() => {
    if (!view.snapshot || !selection) {
      return null;
    }
    const pane = view.snapshot.panes.find((candidate) => candidate.pane_id === selection.paneId);
    const process = pane?.processes.find(
      (candidate) => processKey(candidate) === processKey(selection.process),
    );
    return pane && process ? { paneId: pane.pane_id, process } : null;
  }, [view.snapshot, selection]);

  const selectedPane = selected
    ? view.snapshot?.panes.find((pane) => pane.pane_id === selected.paneId) ?? null
    : null;

  return (
    <section data-testid="agent-processes" className="flex min-w-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className={chromeSansRole('primary')}>Sessions &amp; Processes</h3>
        <RefreshButton
          onClick={() => view.refresh()}
          loading={view.snapshotLoading}
          ariaLabel="Refresh process snapshot"
          variant="ghost"
        />
      </div>

      <SessionSelector
        view={view}
        onSelect={(sessionId) => {
          setSelection(null);
          view.selectSession(sessionId);
        }}
      />
      <ProcessNotices agent={agent} view={view} />
      <SnapshotArea
        view={view}
        selected={selected}
        selectedPane={selectedPane}
        onSelect={setSelection}
      />
    </section>
  );
}

function SessionSelector({
  view,
  onSelect,
}: {
  view: AgentProcessesState;
  onSelect: (sessionId: string) => void;
}) {
  if (view.sessionsError) {
    return (
      <p
        data-testid="agent-processes-sessions-error"
        role="alert"
        className={cn('text-destructive', chromeSansRole('body'))}
      >
        Sessions could not be listed: {view.sessionsError}
      </p>
    );
  }
  if (view.sessionsLoading && view.sessions.length === 0) {
    return <Skeleton data-testid="agent-processes-loading" className="h-8 w-full" />;
  }
  if (view.sessions.length === 0) {
    return (
      <p className={cn('text-muted-foreground', chromeSansRole('body'))}>
        This Agent reports no Sessions.
      </p>
    );
  }
  return (
    <div
      role="group"
      aria-label="Sessions on this Agent"
      className="flex flex-wrap items-center gap-1"
      data-testid="agent-process-session-selector"
    >
      {view.sessions.map((session) => {
        const isSelected = session.session_id === view.selectedSessionId;
        return (
          <Button
            key={session.session_id}
            type="button"
            size="sm"
            variant={isSelected ? 'secondary' : 'ghost'}
            aria-pressed={isSelected}
            onClick={() => onSelect(session.session_id)}
          >
            {session.session_name}
          </Button>
        );
      })}
    </div>
  );
}

function ProcessNotices({ agent, view }: { agent: Agent; view: AgentProcessesState }) {
  const offlineLabel = agent.status === 'degraded' ? 'is degraded' : 'is offline';
  return (
    <>
      {agent.status !== 'online' ? (
        <p
          data-testid="agent-processes-offline"
          className={cn('text-muted-foreground', chromeSansRole('body'))}
        >
          Agent {offlineLabel} — a new process snapshot cannot be read. Last-known facts, if
          any, remain below.
        </p>
      ) : null}
      {view.snapshotError ? (
        <p
          data-testid="agent-processes-error"
          role="alert"
          className={cn('text-destructive', chromeSansRole('body'))}
        >
          {view.snapshotError}
          {view.snapshotStale && view.snapshot
            ? ` Showing the last snapshot from ${formatSnapshotTime(view.snapshot.snapshot_at_ms)}.`
            : ''}
        </p>
      ) : null}
      {view.snapshotLoading && !view.snapshot ? (
        <Skeleton data-testid="agent-processes-snapshot-loading" className="h-24 w-full" />
      ) : null}
    </>
  );
}

function SnapshotArea({
  view,
  selected,
  selectedPane,
  onSelect,
}: {
  view: AgentProcessesState;
  selected: SelectedProcess | null;
  selectedPane: ProcessSnapshot['panes'][number] | null;
  onSelect: (selection: SelectedProcess) => void;
}) {
  if (!view.snapshot) {
    return view.selectedSessionId && !view.snapshotError && !view.snapshotLoading ? (
      <p className={cn('text-muted-foreground', chromeSansRole('body'))}>
        No process snapshot yet. Refresh to ask the Agent.
      </p>
    ) : null;
  }
  return (
    <>
      <SnapshotSection snapshot={view.snapshot} selected={selected} onSelect={onSelect} />
      {selected && selectedPane ? (
        <ProcessInspector
          key={processKey(selected.process)}
          process={selected.process}
          pane={selectedPane}
          snapshot={view.snapshot}
        />
      ) : (
        <p
          data-testid="agent-processes-hint"
          className={cn('text-muted-foreground', chromeSansRole('caption'))}
        >
          Select a process to inspect its sanitized command and resources.
        </p>
      )}
    </>
  );
}

function SnapshotSection({
  snapshot,
  selected,
  onSelect,
}: {
  snapshot: ProcessSnapshot;
  selected: SelectedProcess | null;
  onSelect: (selection: SelectedProcess) => void;
}) {
  const totalProcesses = snapshot.panes.reduce((count, pane) => count + pane.processes.length, 0);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className={cn('min-w-0 truncate', chromeSansRole('primary'))}>
          {snapshot.session_name}
        </h4>
        {snapshot.methods.map((method) => (
          <Badge key={method} variant="outline">
            {methodLabel(method)}
          </Badge>
        ))}
        {snapshot.truncated ? <Badge variant="destructive">truncated</Badge> : null}
      </div>
      <p className={cn('text-muted-foreground', chromeSansRole('caption'))}>
        Snapshot {formatSnapshotTime(snapshot.snapshot_at_ms)} · {snapshot.platform} ·{' '}
        {totalProcesses} process{totalProcesses === 1 ? '' : 'es'} across{' '}
        {snapshot.panes.length} pane{snapshot.panes.length === 1 ? '' : 's'} ·{' '}
        {snapshot.limits.cpu_window_ms} ms CPU window
      </p>

      <ProcessTree panes={snapshot.panes} selected={selected} onSelect={onSelect} />
      <Diagnostics snapshot={snapshot} />
    </div>
  );
}

function Diagnostics({ snapshot }: { snapshot: ProcessSnapshot }) {
  return (
    <details data-testid="agent-process-diagnostics" className="min-w-0">
      <summary className={cn('cursor-pointer text-muted-foreground', chromeSansRole('caption'))}>
        Diagnostics
      </summary>
      <dl className={cn('mt-2 grid gap-2', chromeSansRole('caption'))}>
        {snapshot.panes.map((pane) => (
          <div key={pane.pane_id} className="flex min-w-0 flex-col gap-0.5">
            <dt className={cn('text-muted-foreground', chromeMonoRole('metadata'))}>
              {pane.pane_id} · {methodLabel(pane.method)} · {coverageLabel(pane.coverage)}
            </dt>
            <dd>
              {pane.reason_codes.length > 0
                ? pane.reason_codes.map(reasonLabel).join(' ')
                : 'No fallback or bound reason was reported.'}
            </dd>
          </div>
        ))}
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className={cn('text-muted-foreground', chromeMonoRole('metadata'))}>Limits</dt>
          <dd>
            max {snapshot.limits.max_processes} processes · max depth{' '}
            {snapshot.limits.max_depth} · sampled over {snapshot.limits.cpu_window_ms} ms
          </dd>
        </div>
      </dl>
    </details>
  );
}
