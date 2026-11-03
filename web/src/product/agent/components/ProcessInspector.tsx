import { useState, type ReactNode } from 'react';
import { ChevronDown, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/shared/lib/utils';
import { copyToClipboard } from '@/shared/lib/clipboard';
import {
  chromeLabelRole,
  chromeMonoRole,
  chromeSansRole,
} from '@/shared/typography/chromeRoles';
import type {
  DiscoveredProcess,
  ProcessMetric,
  ProcessSnapshot,
} from '@/product/agent/types';
import {
  aggregateMetric,
  collectDescendants,
  coverageLabel,
  displayAggregate,
  displayCommand,
  displayMetric,
  formatElapsed,
  formatSnapshotTime,
  isSet,
  methodLabel,
  reasonLabel,
  type DisplayMetric,
  type SessionDiscovery,
} from '@/product/agent/model/processSnapshot';

export interface ProcessInspectorProps {
  process: DiscoveredProcess;
  snapshot: ProcessSnapshot;
  discovery: SessionDiscovery;
  /** The current Session's processes, deduplicated by identity. */
  processes: DiscoveredProcess[];
}

type ResourceScope = 'process' | 'subtree';

/**
 * Command-first process inspector (#2514).
 *
 * The executed command and resources are always visible. Process identity and
 * discovery evidence sit behind a default-closed disclosure: selecting a
 * different PID remounts this component (the parent keys it by identity), so
 * the disclosure resets, while a resource-scope toggle for the same PID keeps
 * its state.
 */
export function ProcessInspector({
  process,
  snapshot,
  discovery,
  processes,
}: ProcessInspectorProps) {
  const [scope, setScope] = useState<ResourceScope>('process');
  const scopeProcesses =
    scope === 'subtree' ? collectDescendants(process, processes) : [process];

  return (
    <div
      data-testid="process-inspector"
      className="flex min-w-0 flex-col gap-4"
    >
      <CommandSection process={process} />
      <ResourcesSection
        process={process}
        scope={scope}
        onScopeChange={setScope}
        scopeProcesses={scopeProcesses}
        snapshot={snapshot}
      />
      <ProcessDetails
        process={process}
        snapshot={snapshot}
        discovery={discovery}
      />
    </div>
  );
}

function CommandSection({ process }: { process: DiscoveredProcess }) {
  const canCopy = process.command_state === 'sampled' && process.command.trim().length > 0;

  const copyCommand = async () => {
    try {
      // The sanitized display string is the only thing that may be copied;
      // there is no raw-argv value in the browser to copy instead.
      await copyToClipboard(process.command);
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
      {process.redacted ? (
        <p className={cn('text-muted-foreground', chromeSansRole('caption'))}>
          Sensitive arguments were replaced with [REDACTED]; there is no raw-argv reveal.
        </p>
      ) : null}
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

function ProcessDetails({
  process,
  snapshot,
  discovery,
}: {
  process: DiscoveredProcess;
  snapshot: ProcessSnapshot;
  discovery: SessionDiscovery;
}) {
  const reasons =
    discovery.reasonCodes.length > 0
      ? discovery.reasonCodes.map(reasonLabel).join(' ')
      : 'None reported';
  return (
    <details data-testid="process-details" className="group min-w-0">
      <summary
        className={cn(
          'flex min-h-9 cursor-pointer list-none items-center justify-between gap-3 rounded-[var(--nession-radius-control)] px-2 py-1.5 hover:bg-muted/60',
          '[&::-webkit-details-marker]:hidden',
        )}
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className={cn('text-foreground', chromeSansRole('secondary'))}>Process details</span>
          <span className={cn('truncate text-muted-foreground', chromeSansRole('caption'))}>
            Identity · discovery evidence
          </span>
        </span>
        <ChevronDown
          aria-hidden
          className="size-[length:var(--nession-icon-sm)] shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
        />
      </summary>
      <div
        data-testid="process-details-content"
        className="mt-2 grid min-w-0 gap-3 sm:grid-cols-2"
      >
        <DetailGroup title="Process identity">
          <DetailRow label="PID" value={String(process.pid)} mono />
          <DetailRow
            label="Parent PID"
            value={isSet(process.parent_pid) ? String(process.parent_pid) : 'Unavailable'}
            mono
          />
          <DetailRow label="Executable" value={process.executable || 'Unknown'} mono />
          <DetailRow label="Current Session" value={snapshot.session_name} mono />
        </DetailGroup>
        <DetailGroup title="Discovery evidence">
          <DetailRow
            label="Method"
            value={discovery.methods.map(methodLabel).join(' · ')}
          />
          <DetailRow label="Coverage" value={coverageLabel(discovery.coverage)} />
          <DetailRow label="Snapshot" value={formatSnapshotTime(snapshot.snapshot_at_ms)} />
          <DetailRow label="Reason code" value={reasons} />
        </DetailGroup>
      </div>
    </details>
  );
}

function DetailGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-[var(--nession-radius-surface)] bg-muted/50 p-3">
      <h5 className={cn('text-muted-foreground', chromeLabelRole('metadata'))}>{title}</h5>
      <dl className="flex min-w-0 flex-col gap-1.5">{children}</dl>
    </section>
  );
}

function DetailRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3">
      <dt className={cn('shrink-0 text-muted-foreground', chromeLabelRole('metadata'))}>{label}</dt>
      <dd
        className={cn(
          'min-w-0 break-words text-right',
          mono ? chromeMonoRole('metadata') : chromeSansRole('caption'),
          value === 'Unavailable' || value === 'None reported' ? 'text-muted-foreground' : '',
        )}
        title={value}
      >
        {value}
      </dd>
    </div>
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
