import type { SandboxPolicyDraft } from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';

function ListSection({
  title,
  entries,
  empty,
  testId,
}: {
  title: string;
  entries: string[];
  empty: string;
  testId: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className={cn(chromeSansRole('caption'), 'text-muted-foreground')}>{title}</dt>
      <dd className="min-w-0">
        {entries.length === 0 ? (
          <span
            data-testid={`${testId}-empty`}
            className={cn(chromeSansRole('secondary'), 'text-muted-foreground')}
          >
            {empty}
          </span>
        ) : (
          <ul data-testid={testId} className="flex min-w-0 flex-col gap-1">
            {entries.map((entry) => (
              <li key={entry} className={cn(chromeSansRole('code'), 'min-w-0 break-all')}>
                {entry}
              </li>
            ))}
          </ul>
        )}
      </dd>
    </div>
  );
}

function KvRows({
  group,
  rows,
  testIdPrefix,
}: {
  group: string;
  rows: { key: string; value: string }[];
  testIdPrefix: string;
}) {
  if (rows.length === 0) {
    return (
      <p
        data-testid={`${testIdPrefix}-empty`}
        className={cn(chromeSansRole('secondary'), 'text-muted-foreground')}
      >
        No explicit {group} controls are in this policy.
      </p>
    );
  }
  return (
    <dl data-testid={testIdPrefix} className="flex min-w-0 flex-col gap-2">
      {rows.map((row) => (
        <div
          key={row.key}
          data-testid={`${testIdPrefix}-${row.key}`}
          className="flex min-w-0 flex-col gap-1 rounded-[var(--nession-radius-surface)] bg-muted/40 px-2 py-1 sm:flex-row sm:gap-3"
        >
          <dt className={cn(chromeSansRole('code'), 'shrink-0')}>{row.key}</dt>
          <dd className={cn(chromeSansRole('code'), 'min-w-0 break-all text-muted-foreground')}>
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The Agent-observed effective policy (#3124), rendered read-only.
 *
 * This is the normalized policy the execution was verified against, not the
 * draft the user last edited and not a reconstruction from a digest.
 */
export function SandboxEffectivePolicy({ policy }: { policy: SandboxPolicyDraft }) {
  const namespaces = policy.process?.linux_namespaces;
  const enabledNamespaces = namespaces
    ? (['pid', 'ipc', 'user', 'uts', 'cgroup'] as const).filter(
        (namespace) => namespaces[namespace],
      )
    : [];
  const network = policy.network;
  return (
    <section className="flex min-w-0 flex-col gap-4" aria-label="Effective policy">
      <h3 className={chromeSansRole('primary')}>Effective policy</h3>
      <dl className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-col gap-2">
          <dt className={cn(chromeSansRole('caption'), 'text-muted-foreground')}>
            Filesystem access
          </dt>
          <dd className="flex flex-col gap-2">
            <ListSection
              title="Read-only paths"
              entries={policy.filesystem?.access.read ?? []}
              empty="No explicit read-only allow-list; the backend baseline applies."
              testId="sandbox-effective-file-read"
            />
            <ListSection
              title="Read-write paths"
              entries={policy.filesystem?.access.write ?? []}
              empty="No explicit read-write allow-list."
              testId="sandbox-effective-file-write"
            />
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className={cn(chromeSansRole('caption'), 'text-muted-foreground')}>
            Network
          </dt>
          <dd>
            <span data-testid="sandbox-effective-network-mode" className={chromeSansRole('code')}>
              {network?.mode ?? 'allow'}
            </span>
            {network?.egress ? (
              <div className="mt-2 flex flex-col gap-2">
                <ListSection
                  title="Allowed destinations"
                  entries={network.egress.allow}
                  empty="No destinations are allowed."
                  testId="sandbox-effective-egress-allow"
                />
                <ListSection
                  title="Denied destinations"
                  entries={network.egress.deny}
                  empty="No extra destinations are denied."
                  testId="sandbox-effective-egress-deny"
                />
              </div>
            ) : null}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className={cn(chromeSansRole('caption'), 'text-muted-foreground')}>
            Process namespaces
          </dt>
          <dd data-testid="sandbox-effective-namespaces" className={chromeSansRole('secondary')}>
            {enabledNamespaces.length === 0
              ? 'No explicit Linux namespace request; the backend baseline applies.'
              : enabledNamespaces.join(', ')}
          </dd>
        </div>
        <div className="flex flex-col gap-2">
          <dt className={cn(chromeSansRole('caption'), 'text-muted-foreground')}>
            Resource
          </dt>
          <dd>
            <KvRows
              group="resource"
              rows={policy.resource}
              testIdPrefix="sandbox-effective-resource"
            />
          </dd>
        </div>
        <div className="flex flex-col gap-2">
          <dt className={cn(chromeSansRole('caption'), 'text-muted-foreground')}>
            Syscall
          </dt>
          <dd>
            <KvRows
              group="syscall"
              rows={policy.syscall}
              testIdPrefix="sandbox-effective-syscall"
            />
          </dd>
        </div>
      </dl>
    </section>
  );
}
