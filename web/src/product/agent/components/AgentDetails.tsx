import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { formatRelativeTime } from '@/shared/lib/format';
import { chromeLabelRole, chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import type { Agent } from '@/types';
import type { DomainState } from '@/product/session/model/domainState';
import type { ProcessSnapshot } from '@/product/agent/types';
import {
  coverageLabel,
  methodLabel,
  reasonLabel,
  sessionDiscovery,
} from '@/product/agent/model/processSnapshot';

export interface AgentDetailsProps {
  agent: Agent;
  state: DomainState;
  sessionName: string | null;
  snapshot: ProcessSnapshot | null;
  snapshotLoading: boolean;
  snapshotError: string | null;
}

/**
 * The Agent's own facts, behind one default-closed disclosure (#2514).
 *
 * The resting view stays compact: process work is the subject, not the node
 * metadata. Expanding the row reveals three grouped sections — identity and
 * connection, runtime environment, and capability/discovery — with missing or
 * last-known values stated rather than omitted.
 */
export function AgentDetails({
  agent,
  state,
  sessionName,
  snapshot,
  snapshotLoading,
  snapshotError,
}: AgentDetailsProps) {
  const metadata = agent.metadata;
  const discovery = snapshot ? sessionDiscovery(snapshot) : null;
  const connection = state.agent.copy ?? capitalize(state.agent.channel);
  const heartbeatSuffix = agent.status === 'online' ? '' : ' · last known';

  const discoveryValue = discovery
    ? coverageLabel(discovery.coverage)
    : !sessionName
      ? 'No current Session'
      : snapshotLoading
        ? 'Reading…'
        : snapshotError
          ? 'Unavailable'
          : 'Not read yet';
  const methods = discovery ? discovery.methods.map(methodLabel).join(' · ') : 'Unavailable';
  const reasons =
    discovery && discovery.reasonCodes.length > 0
      ? discovery.reasonCodes.map(reasonLabel).join(' ')
      : 'None reported';

  return (
    <details data-testid="agent-details" className="group min-w-0">
      <summary
        className={cn(
          'flex min-h-9 cursor-pointer list-none items-center justify-between gap-3 rounded-[var(--nession-radius-control)] px-2 py-1.5 hover:bg-muted/60',
          '[&::-webkit-details-marker]:hidden',
        )}
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className={cn('text-foreground', chromeSansRole('secondary'))}>Agent details</span>
          <span className={cn('truncate text-muted-foreground', chromeSansRole('caption'))}>
            Identity · connection · runtime · discovery
          </span>
        </span>
        <ChevronDown
          aria-hidden
          className="size-[length:var(--nession-icon-sm)] shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
        />
      </summary>

      <div
        data-testid="agent-details-content"
        className="mt-2 grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3"
      >
        <DetailGroup title="Identity & connection">
          <DetailRow label="Agent ID" value={agent.agent_id} mono />
          <DetailRow label="Hostname" value={agent.hostname} />
          <DetailRow label="Endpoint" value={`${agent.ip_address}:${agent.port}`} mono />
          <DetailRow label="Connection" value={connection} />
          <DetailRow
            label="Last heartbeat"
            value={`${formatRelativeTime(agent.last_heartbeat)}${heartbeatSuffix}`}
          />
        </DetailGroup>

        <DetailGroup title="Runtime environment">
          <DetailRow label="Operating system" value={metadata?.os_version ?? 'Not reported'} />
          <DetailRow label="Nession version" value={metadata?.nession_version ?? 'Not reported'} mono />
          <DetailRow label="tmux version" value={metadata?.tmux_version ?? 'Not reported'} mono />
          <DetailRow label="Image" value={metadata?.image_tag ?? 'Not reported'} />
        </DetailGroup>

        <DetailGroup title="Capability & discovery">
          <DetailRow label="Terminal" value={terminalCapability(agent)} />
          <DetailRow label="Process discovery" value={discoveryValue} />
          <DetailRow label="Method" value={methods} />
          <DetailRow label="Reason code" value={reasons} />
        </DetailGroup>
      </div>
    </details>
  );
}

function DetailGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-[var(--nession-radius-surface)] bg-muted/50 p-3',
      )}
    >
      <h3 className={cn('text-muted-foreground', chromeLabelRole('metadata'))}>{title}</h3>
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
          value === 'Not reported' || value === 'Unavailable' ? 'text-muted-foreground' : '',
        )}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function capitalize(value: string): string {
  return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value;
}

/** What the Agent advertises for terminal attach, or why it cannot say. */
function terminalCapability(agent: Agent): string {
  if (agent.protocols === undefined) {
    return 'Unknown';
  }
  if (agent.protocols === null) {
    return 'Relay only · no protocol manifest';
  }
  const attach = agent.protocols.protocols['agent.attach'];
  if (!attach) {
    return 'Not advertised';
  }
  return attach.versions.length > 0
    ? `Available (v${attach.versions.join(', v')})`
    : 'Available';
}
