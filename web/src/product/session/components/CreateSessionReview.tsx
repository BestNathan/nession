import { agentDisplayName } from '@/shared/lib/format';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import type { useCreateSessionForm } from '../hooks/useCreateSessionForm';
import {
  agentPlatform,
  managedImageDigest,
  managedImageLabel,
  projectImageSourceLabel,
  toolchainTargetLabel,
} from '../model/managedCreate';

type CreateSessionForm = ReturnType<typeof useCreateSessionForm>;

function ReviewFact({
  label,
  value,
  testId,
}: {
  label: string;
  value: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className={cn('text-muted-foreground', chromeSansRole('caption'))}>{label}</span>
      <span data-testid={testId} className={cn('min-w-0 break-words', chromeSansRole('secondary'))}>
        {value}
      </span>
    </div>
  );
}

function EffectiveEnv({ form }: { form: CreateSessionForm }) {
  return (
    <ReviewFact
      label="Environment"
      testId="managed-review-env"
      value={
        form.effectiveEnv.refs.length === 0
          ? 'No ENV files will be bound'
          : form.effectiveEnv.refs.map((ref) => ref.name).join(', ')
      }
    />
  );
}

function NativeReview({ form }: { form: CreateSessionForm }) {
  return (
    <div
      data-testid="create-session-review-panel"
      className="flex min-w-0 flex-col gap-3"
    >
      <ReviewFact label="Session name" testId="managed-review-name" value={form.sessionName} />
      <ReviewFact label="Runtime" testId="managed-review-runtime" value="Existing Location (Host)" />
      <ReviewFact
        label="Agent"
        testId="managed-review-agent"
        value={form.selectedLocationAgent ? agentDisplayName(form.selectedLocationAgent) : '—'}
      />
      <ReviewFact
        label="Directory"
        testId="managed-review-location"
        value={form.selectedLocation?.path ?? '—'}
      />
      <ReviewFact
        label="Workspace"
        testId="managed-review-workspace"
        value="Project Existing Location · user-owned"
      />
      <EffectiveEnv form={form} />
    </div>
  );
}

function ManagedReview({ form }: { form: CreateSessionForm }) {
  const base = form.managedImages.entries.find(
    (entry) => managedImageDigest(entry) === form.baseDigest,
  );
  const platform = agentPlatform(form.managedAgent);
  return (
    <div
      data-testid="create-session-review-panel"
      className="flex min-w-0 flex-col gap-3"
    >
      <ReviewFact label="Session name" testId="managed-review-name" value={form.sessionName} />
      <ReviewFact label="Runtime" testId="managed-review-runtime" value="Managed (EROFS)" />
      <ReviewFact
        label="Agent"
        testId="managed-review-agent"
        value={`${form.managedAgent ? agentDisplayName(form.managedAgent) : '—'}${
          platform ? ` · ${platform}` : ''
        }`}
      />
      <ReviewFact
        label="Base Runtime"
        testId="managed-review-base"
        value={base ? managedImageLabel(base) : '—'}
      />
      <ReviewFact
        label="Project Source image"
        testId="managed-review-source"
        value={
          form.managedImages.projectSource
            ? `${form.project?.image_digest ?? ''} · ${projectImageSourceLabel(
                form.managedImages.projectSource,
              )}`
            : (form.project?.image_digest ?? '—')
        }
      />
      <ReviewFact
        label="Toolchains (ordered)"
        testId="managed-review-toolchains"
        value={
          form.toolchainDigests.length === 0
            ? 'None'
            : form.toolchainDigests.map((digest, index) => {
                const entry = form.managedImages.entries.find(
                  (candidate) => managedImageDigest(candidate) === digest,
                );
                return `${index + 1}. ${
                  entry ? managedImageLabel(entry) : digest
                } · ${toolchainTargetLabel(entry)}`;
              }).join('\n')
        }
      />
      <ReviewFact
        label="Workspace"
        testId="managed-review-workspace"
        value="Agent-managed durable Workspace · /workspace"
      />
      <EffectiveEnv form={form} />
      <p className={cn('text-muted-foreground', chromeSansRole('caption'))}>
        Create asks the Server to resolve and authorize every digest, then the Agent to
        prepare the composition. A failure refuses the create; there is no Native fallback.
      </p>
    </div>
  );
}

/** The explicit reviewed snapshot immediately before Create (#3794 SC-01). */
export function CreateSessionReview({ form }: { form: CreateSessionForm }) {
  return form.runtimeMode === 'managed' ? (
    <ManagedReview form={form} />
  ) : (
    <NativeReview form={form} />
  );
}
