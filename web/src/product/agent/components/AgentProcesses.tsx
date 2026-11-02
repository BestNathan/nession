import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { RefreshButton } from '@/components/ui/RefreshButton';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/shared/lib/utils';
import { useMediaQuery } from '@/shared/hooks/useMediaQuery';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import type { Agent } from '@/types';
import type { DiscoveredProcess, ProcessCoverage } from '@/product/agent/types';
import type { AgentProcessesState } from '@/product/agent/hooks/useAgentProcesses';
import {
  coverageLabel,
  formatSnapshotTime,
  methodLabel,
  processKey,
  reasonLabel,
  sessionDiscovery,
  sessionProcesses,
} from '@/product/agent/model/processSnapshot';
import { ProcessTree } from './ProcessTree';
import { ProcessInspector } from './ProcessInspector';

export interface AgentProcessesProps {
  agent: Agent;
  view: AgentProcessesState;
}

/**
 * Selected-PID state, kept across snapshot refreshes by identity (PID + start
 * time), plus the App/narrow focus handoff between the forest and the detail.
 */
function useProcessSelection(processes: DiscoveredProcess[], sessionId: string | null) {
  const [selection, setSelection] = useState<DiscoveredProcess | null>(null);
  const selected = useMemo(() => {
    if (!selection) {
      return null;
    }
    const key = processKey(selection);
    return processes.find((process) => processKey(process) === key) ?? null;
  }, [selection, processes]);

  const isWide = useMediaQuery('(min-width: 1024px)');
  const treeRef = useRef<HTMLDivElement>(null);
  const inspectorRef = useRef<HTMLDivElement>(null);
  const focusedKey = useRef<string | null>(null);
  const returnFocusKey = useRef<string | null>(null);

  // A Workspace Session switch is a new observation; never carry the previous
  // Session's selected PID into it.
  useEffect(() => {
    setSelection(null);
  }, [sessionId]);

  // App/narrow detail behaves like a pushed view: focus moves into the detail
  // and Back restores it to the row that opened it. Desktop never steals focus.
  useEffect(() => {
    const key = selected ? processKey(selected) : null;
    if (key === focusedKey.current) {
      return;
    }
    focusedKey.current = key;
    if (isWide) {
      return;
    }
    if (key) {
      const inspector = inspectorRef.current;
      inspector?.focus();
      if (typeof inspector?.scrollIntoView === 'function') {
        inspector.scrollIntoView({ block: 'start' });
      }
      return;
    }
    const keyToRestore = returnFocusKey.current;
    returnFocusKey.current = null;
    if (keyToRestore) {
      treeRef.current
        ?.querySelector<HTMLElement>(`[data-process-key="${keyToRestore}"]`)
        ?.focus();
      if (typeof treeRef.current?.scrollIntoView === 'function') {
        treeRef.current.scrollIntoView({ block: 'start' });
      }
    }
  }, [selected, isWide]);

  const select = (process: DiscoveredProcess) => {
    returnFocusKey.current = processKey(process);
    setSelection(process);
  };

  const back = () => {
    if (selected) {
      returnFocusKey.current = processKey(selected);
    }
    setSelection(null);
  };

  return { selected, select, back, treeRef, inspectorRef };
}

/**
 * The current Session's processes inside the existing Agent capability (#2514).
 *
 * This is one Session-scoped observation, not an Agent-wide process list: there
 * is no Session selector and no Pane/Window grouping. On desktop the forest and
 * the selected-process inspector sit side by side; on the App/narrow layout the
 * forest is the root and selecting a process pushes its detail with a Back that
 * returns focus to the same row.
 */
export function AgentProcesses({ agent, view }: AgentProcessesProps) {
  const snapshot = view.snapshot;
  const processes = useMemo(
    () => (snapshot ? sessionProcesses(snapshot.panes) : []),
    [snapshot],
  );
  const discovery = useMemo(
    () => (snapshot ? sessionDiscovery(snapshot) : null),
    [snapshot],
  );
  const { selected, select, back, treeRef, inspectorRef } = useProcessSelection(
    processes,
    view.sessionId,
  );

  return (
    <section data-testid="agent-processes" className="flex min-w-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className={chromeSansRole('primary')}>Processes</h3>
        <RefreshButton
          onClick={() => view.refresh()}
          disabled={agent.status !== 'online' || !view.sessionId}
          loading={view.snapshotLoading}
          ariaLabel="Refresh process snapshot"
          variant="ghost"
        />
      </div>

      <SessionIdentity view={view} />
      <ProcessNotices agent={agent} view={view} discovery={discovery} />

      {!view.sessionId ? (
        <p
          data-testid="agent-processes-no-session"
          className={cn('text-muted-foreground', chromeSansRole('body'))}
        >
          No current Session. Open this Agent from a Session to inspect that Session&apos;s
          processes; the Agent&apos;s other Sessions are never chosen automatically.
        </p>
      ) : null}

      {view.sessionId && view.snapshotLoading && !snapshot ? (
        <Skeleton data-testid="agent-processes-snapshot-loading" className="h-24 w-full" />
      ) : null}

      {snapshot && discovery ? (
        <>
          <SnapshotHeader
            snapshot={snapshot}
            discovery={discovery}
            processCount={processes.length}
          />

          <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
            <div
              ref={treeRef}
              className={cn(
                'flex min-w-0 flex-col gap-1',
                selected ? 'hidden lg:flex' : 'flex',
              )}
            >
              <p className={cn('text-muted-foreground', chromeSansRole('caption'))}>
                {processes.length} discovered
              </p>
              <ProcessTree
                processes={processes}
                selected={selected}
                onSelect={select}
              />
            </div>

            <div
              ref={inspectorRef}
              tabIndex={-1}
              aria-label="Selected process inspector"
              className={cn(
                'min-w-0 rounded-[var(--nession-radius-surface)] focus:outline-none lg:p-0',
                selected ? 'flex flex-col gap-3' : 'hidden lg:block',
              )}
            >
              {selected ? (
                <>
                  <button
                    type="button"
                    onClick={() => back()}
                    className={cn(
                      'flex min-h-9 w-fit items-center gap-1 rounded-[var(--nession-radius-control)] px-2 text-muted-foreground hover:bg-muted/60 lg:hidden',
                      chromeSansRole('secondary'),
                    )}
                  >
                    <ArrowLeft aria-hidden className="size-[length:var(--nession-icon-sm)]" />
                    Back to processes
                  </button>
                  <ProcessInspector
                    key={processKey(selected)}
                    process={selected}
                    snapshot={snapshot}
                    discovery={discovery}
                    processes={processes}
                  />
                </>
              ) : (
                <p className={cn('text-muted-foreground', chromeSansRole('caption'))}>
                  Select a process to inspect its sanitized command and resources.
                </p>
              )}
            </div>
          </div>

          <Diagnostics snapshot={snapshot} discovery={discovery} />
        </>
      ) : null}
    </section>
  );
}

function SessionIdentity({ view }: { view: AgentProcessesState }) {
  if (!view.sessionId) {
    return null;
  }
  return (
    <div data-testid="agent-process-session" className="flex min-w-0 flex-wrap items-baseline gap-2">
      <span className={cn('text-muted-foreground', chromeSansRole('caption'))}>
        Current Session
      </span>
      <span className={cn('min-w-0 truncate', chromeMonoRole('code'))}>
        {view.sessionName ?? view.sessionId}
      </span>
    </div>
  );
}

function ProcessNotices({
  agent,
  view,
  discovery,
}: {
  agent: Agent;
  view: AgentProcessesState;
  discovery: ReturnType<typeof sessionDiscovery> | null;
}) {
  const offlineLabel = agent.status === 'degraded' ? 'is degraded' : 'is offline';
  return (
    <>
      {agent.status !== 'online' ? (
        <p
          data-testid="agent-processes-offline"
          className={cn('text-muted-foreground', chromeSansRole('body'))}
        >
          Agent {offlineLabel} — a new process snapshot cannot be read. Last-known facts, if
          any, remain below; no process count is inferred.
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
      {discovery && discovery.coverage === 'partial' ? (
        <p
          data-testid="agent-processes-coverage"
          className={cn('text-muted-foreground', chromeSansRole('caption'))}
        >
          Partial discovery
          {discovery.reasonCodes.length > 0
            ? ` — ${discovery.reasonCodes.map(reasonLabel).join(' ')}`
            : '.'}
        </p>
      ) : null}
    </>
  );
}

function SnapshotHeader({
  snapshot,
  discovery,
  processCount,
}: {
  snapshot: NonNullable<AgentProcessesState['snapshot']>;
  discovery: ReturnType<typeof sessionDiscovery>;
  processCount: number;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className={cn('min-w-0 truncate', chromeSansRole('primary'))}>
          {snapshot.session_name}
        </h4>
        {discovery.methods.map((method) => (
          <Badge key={method} variant="outline">
            {methodLabel(method)}
          </Badge>
        ))}
        <Badge variant={coverageVariant(discovery.coverage)}>
          {coverageLabel(discovery.coverage)}
        </Badge>
        {snapshot.truncated ? <Badge variant="destructive">truncated</Badge> : null}
      </div>
      <p className={cn('text-muted-foreground', chromeSansRole('caption'))}>
        {processCount} process{processCount === 1 ? '' : 'es'} · Snapshot{' '}
        {formatSnapshotTime(snapshot.snapshot_at_ms)} · {snapshot.platform} ·{' '}
        {snapshot.limits.cpu_window_ms} ms CPU window
      </p>
    </div>
  );
}

function Diagnostics({
  snapshot,
  discovery,
}: {
  snapshot: NonNullable<AgentProcessesState['snapshot']>;
  discovery: ReturnType<typeof sessionDiscovery>;
}) {
  return (
    <details data-testid="agent-process-diagnostics" className="min-w-0">
      <summary className={cn('cursor-pointer text-muted-foreground', chromeSansRole('caption'))}>
        Discovery diagnostics
      </summary>
      <dl className={cn('mt-2 grid gap-2', chromeSansRole('caption'))}>
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className={cn('text-muted-foreground', chromeMonoRole('metadata'))}>Scope</dt>
          <dd>Current Session only · internal execution-unit identifiers are not shown.</dd>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className={cn('text-muted-foreground', chromeMonoRole('metadata'))}>Method</dt>
          <dd>
            {discovery.methods.map(methodLabel).join(' · ')} · {coverageLabel(discovery.coverage)}
          </dd>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className={cn('text-muted-foreground', chromeMonoRole('metadata'))}>Reasons</dt>
          <dd>
            {discovery.reasonCodes.length > 0
              ? discovery.reasonCodes.map(reasonLabel).join(' ')
              : 'No fallback or bound reason was reported.'}
          </dd>
        </div>
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

function coverageVariant(coverage: ProcessCoverage): 'secondary' | 'outline' | 'destructive' {
  switch (coverage) {
    case 'complete':
      return 'secondary';
    case 'partial':
      return 'outline';
    default:
      return 'destructive';
  }
}
