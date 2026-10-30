import { useState } from 'react';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/shared/lib/utils';
import {
  chromeLabelRole,
  chromeMonoRole,
  chromeSansRole,
} from '@/shared/typography/chromeRoles';
import type {
  DiscoveredProcess,
  PaneProcessSnapshot,
  ProcessMetric,
  ProcessSnapshot,
} from '@/product/agent/types';
import {
  aggregateMetric,
  collectDescendants,
  displayAggregate,
  displayCommand,
  displayMetric,
  formatElapsed,
  isSet,
  methodLabel,
  reasonLabel,
  type DisplayMetric,
} from '@/product/agent/model/processSnapshot';

export interface ProcessInspectorProps {
  process: DiscoveredProcess;
  pane: PaneProcessSnapshot;
  snapshot: ProcessSnapshot;
}

type ResourceScope = 'process' | 'subtree';

/**
 * Command-first process inspector (#2514).
 *
 * The selected command always belongs to the selected PID. The resource scope
 * changes only which processes the metrics are summed over: the PPID
 * descendant subtree walks parent edges and never absorbs a cgroup-only
 * reparented worker into the selected process's ancestry.
 */
export function ProcessInspector({ process, pane, snapshot }: ProcessInspectorProps) {
  const [scope, setScope] = useState<ResourceScope>('process');
  const scopeProcesses =
    scope === 'subtree' ? collectDescendants(process, pane.processes) : [process];

  return (
    <div data-testid="process-inspector" className="flex min-w-0 flex-col gap-4">
      <CommandSection process={process} />
      <ResourcesSection
        process={process}
        scope={scope}
        onScopeChange={setScope}
        scopeProcesses={scopeProcesses}
        snapshot={snapshot}
      />
      <IdentitySection process={process} pane={pane} />
    </div>
  );
}

function CommandSection({ process }: { process: DiscoveredProcess }) {
  const canCopy = process.command_state === 'sampled' && process.command.trim().length > 0;

  const copyCommand = async () => {
    try {
      // The sanitized display string is the only thing that may be copied;
      // there is no raw-argv value in the browser to copy instead.
      await navigator.clipboard.writeText(process.command);
      toast.success('Sanitized command copied');
    } catch {
      toast.error('Copy failed — the browser denied clipboard access');
    }
  };

  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className={chromeSansRole('primary')}>Executed command</h4>
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={!canCopy}
          onClick={() => void copyCommand()}
        >
          <Copy aria-hidden />
          Copy command
        </Button>
      </div>
      <div
        data-testid="process-command"
        className={cn(
          'rounded-[var(--nession-radius-surface)] bg-muted px-2.5 py-2 whitespace-pre-wrap break-all',
          chromeMonoRole('code'),
        )}
      >
        {canCopy ? process.command : displayCommand(process)}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline">{process.executable}</Badge>
        {process.redacted ? <Badge variant="secondary">redacted</Badge> : null}
        {process.truncated ? <Badge variant="outline">truncated</Badge> : null}
        {process.command_state !== 'sampled' ? (
          <Badge variant="destructive">
            command unavailable
            {process.command_reason ? ` · ${process.command_reason}` : ''}
          </Badge>
        ) : null}
      </div>
      <p className={cn('text-muted-foreground', chromeSansRole('caption'))}>
        PID {process.pid}
        {isSet(process.start_time_ms)
          ? ` · started ${new Date(process.start_time_ms).toLocaleString()}`
          : ' · start time unavailable'}
      </p>
    </section>
  );
}

function ResourcesSection({
  process,
  scope,
  onScopeChange,
  scopeProcesses,
  snapshot,
}: {
  process: DiscoveredProcess;
  scope: ResourceScope;
  onScopeChange: (scope: ResourceScope) => void;
  scopeProcesses: DiscoveredProcess[];
  snapshot: ProcessSnapshot;
}) {
  const metric = (
    metricOf: (candidate: DiscoveredProcess) => ProcessMetric,
    unit: string,
    digits = 1,
  ): DisplayMetric =>
    scope === 'subtree'
      ? displayAggregate(aggregateMetric(scopeProcesses, metricOf), unit, digits)
      : displayMetric(metricOf(process), unit, digits);

  const elapsed =
    process.elapsed_ms.state === 'sampled' && isSet(process.elapsed_ms.value)
      ? { text: formatElapsed(process.elapsed_ms.value), unavailable: false }
      : displayMetric(process.elapsed_ms, '', 0);

  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className={chromeSansRole('primary')}>Resources</h4>
        <div role="group" aria-label="Resource scope" className="flex items-center gap-1">
          <Button
            type="button"
            size="xs"
            variant={scope === 'process' ? 'secondary' : 'ghost'}
            aria-pressed={scope === 'process'}
            onClick={() => onScopeChange('process')}
          >
            This process
          </Button>
          <Button
            type="button"
            size="xs"
            variant={scope === 'subtree' ? 'secondary' : 'ghost'}
            aria-pressed={scope === 'subtree'}
            onClick={() => onScopeChange('subtree')}
          >
            With descendants
          </Button>
        </div>
      </div>
      <p className={cn('text-muted-foreground', chromeSansRole('caption'))}>
        {scope === 'process'
          ? `One process · ${snapshot.limits.cpu_window_ms} ms sampling window`
          : `${scopeProcesses.length} processes · includes PID ${process.pid} · PPID descendants only`}
      </p>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <MetricCell
          label="CPU (% of one CPU)"
          value={metric((candidate) => candidate.cpu_percent, '%')}
          testId="process-metric-cpu"
        />
        <MetricCell
          label="RSS (MiB)"
          value={metric((candidate) => candidate.rss_mib, ' MiB')}
          testId="process-metric-rss"
        />
        <MetricCell
          label="Threads"
          value={metric((candidate) => candidate.threads, '', 0)}
          testId="process-metric-threads"
        />
        <MetricCell
          label={scope === 'subtree' ? 'Elapsed (selected process)' : 'Elapsed'}
          value={elapsed}
          testId="process-metric-elapsed"
        />
        <MetricCell
          label="Read I/O (KiB/s)"
          value={metric((candidate) => candidate.io_read_kib_per_s, ' KiB/s')}
          testId="process-metric-read"
        />
        <MetricCell
          label="Write I/O (KiB/s)"
          value={metric((candidate) => candidate.io_write_kib_per_s, ' KiB/s')}
          testId="process-metric-write"
        />
      </dl>
      <p className={cn('text-muted-foreground', chromeSansRole('caption'))}>
        Missing or denied metrics are shown as unavailable, never as zero. A subtree aggregate with
        an incomplete member is unavailable.
      </p>
    </section>
  );
}

function IdentitySection({
  process,
  pane,
}: {
  process: DiscoveredProcess;
  pane: PaneProcessSnapshot;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h4 className={chromeSansRole('primary')}>Identity and membership evidence</h4>
      <dl className={cn('grid grid-cols-2 gap-x-4 gap-y-1', chromeSansRole('body'))}>
        <IdentityRow label="PID" value={String(process.pid)} />
        <IdentityRow
          label="Parent PID"
          value={isSet(process.parent_pid) ? String(process.parent_pid) : 'Unavailable'}
        />
        <IdentityRow
          label="Start time"
          value={
            isSet(process.start_time_ms)
              ? new Date(process.start_time_ms).toLocaleString()
              : 'Unavailable'
          }
        />
        <IdentityRow label="TTY" value={process.tty ?? 'Unavailable'} />
        <IdentityRow label="SID" value={isSet(process.sid) ? String(process.sid) : 'Unavailable'} />
        <IdentityRow
          label="PGID"
          value={isSet(process.pgid) ? String(process.pgid) : 'Unavailable'}
        />
      </dl>
      <p className={cn('text-muted-foreground', chromeSansRole('caption'))}>
        Pane method: {methodLabel(pane.method)} · coverage: {pane.coverage}
        {pane.reason_codes.length > 0
          ? ` · ${pane.reason_codes.map(reasonLabel).join(' ')}`
          : ''}
      </p>
    </section>
  );
}

function MetricCell({
  label,
  value,
  testId,
}: {
  label: string;
  value: DisplayMetric;
  testId: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-testid={testId}>
      <dt className={cn('text-muted-foreground', chromeLabelRole('metadata'))}>{label}</dt>
      <dd
        className={cn(
          value.unavailable ? 'text-muted-foreground' : '',
          chromeSansRole('body'),
        )}
      >
        {value.text}
      </dd>
      {value.detail ? (
        <span className={cn('text-muted-foreground break-words', chromeSansRole('caption'))}>
          {value.detail}
        </span>
      ) : null}
    </div>
  );
}

function IdentityRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate" title={value}>
        {value}
      </dd>
    </div>
  );
}
