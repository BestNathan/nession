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

function enabledNamespaces(policy: SandboxPolicyDraft): string[] {
  const namespaces = policy.process?.linux_namespaces;
  if (!namespaces) {
    return [];
  }
  return (['pid', 'ipc', 'user', 'uts', 'cgroup'] as const).filter(
    (namespace) => namespaces[namespace],
  );
}

/** Observed filesystem policy plus the read-only prepared-composition fact. */
export function SandboxEffectiveFilesystem({
  policy,
  mechanisms,
}: {
  policy: SandboxPolicyDraft;
  mechanisms: string[];
}) {
  const erofs = mechanisms.includes('filesystem.erofs');
  return (
    <section aria-label="Effective filesystem" className="flex min-w-0 flex-col gap-4">
      {erofs ? (
        <div
          data-testid="sandbox-effective-erofs"
          className="flex min-w-0 flex-col gap-1 rounded-[var(--nession-radius-surface)] bg-muted/30 p-2"
        >
          <span className={chromeSansRole('secondary')}>Prepared root composition</span>
          <p className={cn(chromeSansRole('caption'), 'text-muted-foreground')}>
            This execution used an Agent-prepared EROFS root: Base Runtime at /, workspace at
            /workspace and read-only toolchains under /opt/&lt;name&gt;. Image sources and digests
            are Server/Agent execution inputs and are not exposed to Web.
          </p>
        </div>
      ) : null}
      <dl className="flex min-w-0 flex-col gap-3">
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
      </dl>
    </section>
  );
}

/** Observed network mode and applied egress rule sets. */
export function SandboxEffectiveNetwork({ policy }: { policy: SandboxPolicyDraft }) {
  const network = policy.network;
  return (
    <section aria-label="Effective network" className="flex min-w-0 flex-col gap-3">
      <dl className="flex min-w-0 flex-col gap-1">
        <dt className={cn(chromeSansRole('caption'), 'text-muted-foreground')}>Mode</dt>
        <dd>
          <span data-testid="sandbox-effective-network-mode" className={chromeSansRole('code')}>
            {network?.mode ?? 'allow'}
          </span>
        </dd>
      </dl>
      {network?.egress ? (
        <dl className="flex min-w-0 flex-col gap-3">
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
        </dl>
      ) : null}
    </section>
  );
}

/** Observed installed Linux namespace requests. */
export function SandboxEffectiveProcess({ policy }: { policy: SandboxPolicyDraft }) {
  const namespaces = enabledNamespaces(policy);
  return (
    <section aria-label="Effective process">
      <p data-testid="sandbox-effective-namespaces" className={chromeSansRole('secondary')}>
        {namespaces.length === 0
          ? 'No explicit Linux namespace request; the backend baseline applies.'
          : namespaces.join(', ')}
      </p>
    </section>
  );
}

/** Observed resource-control rows. */
export function SandboxEffectiveResource({ policy }: { policy: SandboxPolicyDraft }) {
  return (
    <section aria-label="Effective resource">
      <KvRows
        group="resource"
        rows={policy.resource}
        testIdPrefix="sandbox-effective-resource"
      />
    </section>
  );
}

/** Observed seccomp profile rows. */
export function SandboxEffectiveSyscall({ policy }: { policy: SandboxPolicyDraft }) {
  return (
    <section aria-label="Effective syscall">
      <KvRows
        group="syscall"
        rows={policy.syscall}
        testIdPrefix="sandbox-effective-syscall"
      />
    </section>
  );
}
