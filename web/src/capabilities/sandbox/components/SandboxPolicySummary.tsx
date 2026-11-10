import { Button } from '@/components/ui/button';
import type { SandboxPolicyDraft } from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import type { SandboxTabId } from './SandboxPolicyTabs';

function namespacesLabel(policy: SandboxPolicyDraft): string {
  const namespaces = policy.process?.linux_namespaces;
  if (!namespaces) {
    return 'Baseline only';
  }
  const enabled = (['pid', 'ipc', 'user', 'uts', 'cgroup'] as const).filter(
    (namespace) => namespaces[namespace],
  );
  return enabled.length === 0 ? 'Baseline only' : enabled.join(', ');
}

function summaryRows(policy: SandboxPolicyDraft): { id: SandboxTabId; label: string; value: string }[] {
  const read = policy.filesystem?.access.read.length ?? 0;
  const write = policy.filesystem?.access.write.length ?? 0;
  const network = policy.network;
  const egress = network?.egress;
  return [
    {
      id: 'filesystem',
      label: 'Filesystem',
      value:
        read === 0 && write === 0
          ? 'No explicit paths'
          : `${read} read · ${write} write paths`,
    },
    {
      id: 'network',
      label: 'Network',
      value: egress
        ? `${network?.mode ?? 'allow'} · ${egress.allow.length} allow · ${egress.deny.length} deny`
        : (network?.mode ?? 'allow'),
    },
    { id: 'process', label: 'Process', value: namespacesLabel(policy) },
    {
      id: 'resource',
      label: 'Resource',
      value:
        policy.resource.length === 0
          ? 'No native controls'
          : `${policy.resource.length} native controls`,
    },
    {
      id: 'syscall',
      label: 'Syscall',
      value: policy.syscall[0]?.value || 'No profile',
    },
  ];
}

export interface SandboxPolicySummaryProps {
  policy: SandboxPolicyDraft;
  onSelectTab: (tab: SandboxTabId) => void;
}

/**
 * The Overview's five-dimension summary (#3143).
 *
 * Each row is a direct, local switch to its peer tab — the same navigation as
 * the tab strip, with no intermediate Sandbox home page.
 */
export function SandboxPolicySummary({ policy, onSelectTab }: SandboxPolicySummaryProps) {
  return (
    <section data-testid="sandbox-summary" className="flex min-w-0 flex-col gap-1">
      {summaryRows(policy).map((row) => (
        <Button
          key={row.id}
          type="button"
          variant="ghost"
          data-testid={`sandbox-summary-${row.id}`}
          className="min-h-11 w-full justify-between gap-3 px-2"
          onClick={() => onSelectTab(row.id)}
        >
          <span className={chromeSansRole('secondary')}>{row.label}</span>
          <span
            className={cn(
              chromeSansRole('caption'),
              'min-w-0 truncate text-muted-foreground',
            )}
          >
            {row.value}
          </span>
        </Button>
      ))}
    </section>
  );
}

/**
 * The exact assembled payload Enter will submit (#3143 SC-05).
 *
 * This is the canonical Web-safe draft, not a separately reconstructed
 * policy; the Agent remains the only materializer/validator.
 */
export function SandboxPolicyPreview({ policy }: { policy: SandboxPolicyDraft }) {
  return (
    <section className="flex min-w-0 flex-col gap-1">
      <h3 className={cn(chromeSansRole('caption'), 'text-muted-foreground')}>
        Assembled policy payload
      </h3>
      <pre
        data-testid="sandbox-policy-preview"
        className={cn(
          chromeMonoRole('code'),
          'max-h-64 min-w-0 overflow-auto rounded-[var(--nession-radius-surface)] bg-muted/30 p-2',
        )}
      >
        {JSON.stringify(policy, null, 2)}
      </pre>
    </section>
  );
}
