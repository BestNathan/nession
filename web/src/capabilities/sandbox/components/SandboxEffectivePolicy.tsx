import type { SandboxPolicyDraft } from '@/generated/protocol/core/server-session-sandbox-context/v1';
import {
  DetailEmpty,
  DetailFact,
  DetailFacts,
  DetailNote,
  DetailSection,
} from '@/components/ui/resource-detail';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
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
    <DetailFact label={title} mono>
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
            <li key={entry} className={cn(chromeMonoRole('code'), 'min-w-0 break-all')}>
              {entry}
            </li>
          ))}
        </ul>
      )}
    </DetailFact>
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
      <DetailEmpty data-testid={`${testIdPrefix}-empty`}>
        No explicit {group} controls are in this policy.
      </DetailEmpty>
    );
  }
  return (
    <DetailFacts data-testid={testIdPrefix} className="gap-2">
      {rows.map((row) => (
        <DetailFact
          key={row.key}
          label={row.key}
          mono
          testId={`${testIdPrefix}-${row.key}`}
        >
          {row.value}
        </DetailFact>
      ))}
    </DetailFacts>
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
        <DetailSection
          title="Prepared root composition"
          level="h3"
          testId="sandbox-effective-erofs"
        >
          <DetailNote>
            This execution used an Agent-prepared EROFS root: Base Runtime at /, workspace at
            /workspace and read-only toolchains under /opt/&lt;name&gt;. Image sources and digests
            are Server/Agent execution inputs and are not exposed to Web.
          </DetailNote>
        </DetailSection>
      ) : null}
      <DetailFacts>
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
      </DetailFacts>
    </section>
  );
}

/** Observed network mode and applied egress rule sets. */
export function SandboxEffectiveNetwork({ policy }: { policy: SandboxPolicyDraft }) {
  const network = policy.network;
  return (
    <section aria-label="Effective network" className="flex min-w-0 flex-col gap-3">
      <DetailFacts className="gap-1.5">
        <DetailFact label="Mode" mono valueTestId="sandbox-effective-network-mode">
          {network?.mode ?? 'allow'}
        </DetailFact>
      </DetailFacts>
      {network?.egress ? (
        <DetailFacts>
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
        </DetailFacts>
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
