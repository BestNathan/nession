import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import { agentDisplayName } from '@/shared/lib/format';
import { cn } from '@/shared/lib/utils';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import type { useCreateSessionForm } from '../hooks/useCreateSessionForm';
import {
  agentPlatform,
  imageCandidateBlockReason,
  managedImageDigest,
  managedImageLabel,
  projectImageSourceLabel,
  projectSourceIsStale,
  toolchainTargetLabel,
} from '../model/managedCreate';

type CreateSessionForm = ReturnType<typeof useCreateSessionForm>;

function RuntimeChoice({
  value,
  title,
  description,
  selected,
  blockedReason,
  onSelect,
}: {
  value: 'native' | 'managed';
  title: string;
  description: string;
  selected: boolean;
  blockedReason: string | null;
  onSelect: (value: 'native' | 'managed') => void;
}) {
  return (
    <label
      data-testid={`session-runtime-${value}`}
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-[var(--nession-radius-surface)] border px-3 py-2 transition-colors',
        selected ? 'border-primary bg-primary/10' : 'border-input',
        blockedReason !== null && 'cursor-not-allowed opacity-60',
      )}
    >
      <input
        type="radio"
        name="session-runtime"
        value={value}
        checked={selected}
        disabled={blockedReason !== null}
        onChange={() => onSelect(value)}
        className="mt-0.5 size-4 accent-primary"
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={chromeSansRole('primary')}>{title}</span>
        <span className={cn('text-muted-foreground', chromeSansRole('caption'))}>
          {blockedReason ?? description}
        </span>
      </span>
    </label>
  );
}

/** The explicit Host (Existing Location) vs EROFS Managed choice (#3794). */
export function CreateSessionRuntimeChoice({ form }: { form: CreateSessionForm }) {
  const nativeBlocked =
    form.locations.length === 0 ? 'No Existing Location is declared in Project settings' : null;
  const managedBlocked = !form.project?.image_digest
    ? 'The Project does not pin a Source image'
    : form.onlineAgents.length === 0
      ? 'No online Agent is available'
      : null;
  return (
    <div className="flex flex-col gap-2">
      <Label>Session runtime</Label>
      <div role="radiogroup" aria-label="Session runtime" className="flex flex-col gap-2">
        <RuntimeChoice
          value="native"
          title="Existing Location (Host)"
          description="Run on the Project’s declared Agent directory. No image is prepared."
          selected={form.runtimeMode === 'native'}
          blockedReason={nativeBlocked}
          onSelect={form.setRuntimeMode}
        />
        <RuntimeChoice
          value="managed"
          title="Managed (EROFS)"
          description="Prepare the pinned Project image, a Base Runtime and ordered toolchains on the Agent."
          selected={form.runtimeMode === 'managed'}
          blockedReason={
            form.managedImages.error
              ? `Image Library is unavailable: ${form.managedImages.error}`
              : managedBlocked
          }
          onSelect={form.setRuntimeMode}
        />
      </div>
    </div>
  );
}

function AgentField({ form }: { form: CreateSessionForm }) {
  const { managedAgent } = form;
  const platform = agentPlatform(managedAgent);
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="managed-agent">Agent</Label>
      <Select
        value={form.managedAgentId}
        onValueChange={(value) => value && form.setManagedAgentId(value)}
        disabled={form.loading || form.onlineAgents.length === 0}
      >
        <SelectTrigger id="managed-agent" className="w-full" data-testid="managed-create-agent">
          <span className={managedAgent ? '' : 'text-muted-foreground'}>
            {managedAgent
              ? `${agentDisplayName(managedAgent)}${
                  platform ? ` · ${platform}` : ' · no platform advertised'
                }`
              : 'Select an online Agent'}
          </span>
        </SelectTrigger>
        <SelectContent width="content">
          {form.onlineAgents.map((agent) => (
            <SelectItem key={agent.agent_id} value={agent.agent_id} anatomy="resource">
              {agentDisplayName(agent)}
              {agentPlatform(agent) ? ` · ${agentPlatform(agent)}` : ' · no platform advertised'}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {form.onlineAgents.length === 0 ? (
        <p className="text-destructive" data-testid="managed-create-no-agent">
          No online Agent can prepare a Managed Session.
        </p>
      ) : null}
    </div>
  );
}

function BaseField({ form }: { form: CreateSessionForm }) {
  const platform = agentPlatform(form.managedAgent);
  const selected = form.managedImages.entries.find(
    (entry) => managedImageDigest(entry) === form.baseDigest,
  );
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="managed-base">Base Runtime image</Label>
      <Select
        value={form.baseDigest}
        onValueChange={(value) => value && form.setBaseDigest(value)}
        disabled={form.loading || form.managedImages.loading}
      >
        <SelectTrigger id="managed-base" className="w-full" data-testid="managed-create-base">
          <span className={selected ? '' : 'text-muted-foreground'}>
            {selected ? managedImageLabel(selected) : 'Select a Base Runtime'}
          </span>
        </SelectTrigger>
        <SelectContent width="content">
          {form.managedImages.entries.map((entry) => {
            const reason = imageCandidateBlockReason(entry, 'base_runtime', platform);
            return (
              <SelectItem
                key={managedImageDigest(entry)}
                value={managedImageDigest(entry)}
                disabled={reason !== null}
                anatomy="resource"
              >
                {managedImageLabel(entry)}
                {reason ? ` · ${reason}` : ''}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      {form.managedImages.error ? (
        <p className="text-destructive" data-testid="managed-create-library-error">
          {form.managedImages.error}
        </p>
      ) : null}
    </div>
  );
}

function ProjectSourceField({ form }: { form: CreateSessionForm }) {
  const { projectSource, projectSourceLoading, projectSourceError } = form.managedImages;
  const project = form.project;
  return (
    <div
      data-testid="managed-create-project-source"
      className="flex flex-col gap-1 rounded-[var(--nession-radius-surface)] border px-3 py-2"
    >
      <span className={chromeSansRole('secondary')}>Project Source image (pinned)</span>
      <span className={cn('break-all', chromeMonoRole('metadata'))} data-testid="managed-create-source-digest">
        {project?.image_digest ?? 'Not pinned'}
      </span>
      {projectSourceLoading ? (
        <span className="text-muted-foreground" data-testid="managed-create-source-loading">
          Reading the pinned image…
        </span>
      ) : projectSourceError ? (
        <span className="text-destructive" data-testid="managed-create-source-error">
          {projectSourceError}
        </span>
      ) : projectSource ? (
        <>
          <span
            className="text-muted-foreground"
            data-testid="managed-create-source-origin"
          >
            {projectImageSourceLabel(projectSource)}
          </span>
          <span
            className={cn(
              projectSource.status === 'ready' ? 'text-muted-foreground' : 'text-destructive',
            )}
            data-testid="managed-create-source-status"
          >
            {projectSource.status === 'ready' ? 'Server Ready' : `Build ${projectSource.status}`}
          </span>
          {project && projectSourceIsStale(project, projectSource) ? (
            <span className="text-destructive" data-testid="managed-create-source-stale">
              The Project Git Source changed after this image was pinned. Re-pin the image before
              creating.
            </span>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ToolchainField({ form }: { form: CreateSessionForm }) {
  const platform = agentPlatform(form.managedAgent);
  const selectedEntries = form.toolchainDigests.map((digest) =>
    form.managedImages.entries.find((entry) => managedImageDigest(entry) === digest),
  );
  return (
    <div className="flex flex-col gap-2">
      <Label>Toolchains (ordered)</Label>
      <div className="flex flex-col gap-1" data-testid="managed-create-toolchains">
        {form.toolchainDigests.length === 0 ? (
          <p className="text-muted-foreground" data-testid="managed-create-toolchains-empty">
            No toolchains. The Base Runtime only.
          </p>
        ) : (
          form.toolchainDigests.map((digest, index) => (
            <div
              key={digest}
              data-testid={`managed-create-toolchain-${index}`}
              className="flex min-w-0 items-center gap-2 rounded-[var(--nession-radius-control)] border px-2 py-1"
            >
              <span className={cn('min-w-0 flex-1 break-all', chromeMonoRole('metadata'))}>
                {selectedEntries[index]
                  ? managedImageLabel(selectedEntries[index])
                  : digest}
                <span className="ml-2 text-muted-foreground">
                  {toolchainTargetLabel(selectedEntries[index])}
                </span>
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Move toolchain ${index + 1} up`}
                disabled={index === 0}
                onClick={() => form.moveToolchain(digest, -1)}
              >
                ↑
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Move toolchain ${index + 1} down`}
                disabled={index === form.toolchainDigests.length - 1}
                onClick={() => form.moveToolchain(digest, 1)}
              >
                ↓
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Remove toolchain ${index + 1}`}
                onClick={() => form.toggleToolchain(digest)}
              >
                Remove
              </Button>
            </div>
          ))
        )}
      </div>
      <div className="flex flex-col gap-1">
        {form.managedImages.entries.map((entry) => {
          const digest = managedImageDigest(entry);
          const reason = imageCandidateBlockReason(entry, 'tool', platform);
          if (reason !== null || form.toolchainDigests.includes(digest)) {
            return null;
          }
          return (
            <Button
              key={digest}
              type="button"
              size="sm"
              variant="outline"
              className="justify-start"
              data-testid="managed-create-toolchain-add"
              onClick={() => form.toggleToolchain(digest)}
            >
              Add {managedImageLabel(entry)} · {toolchainTargetLabel(entry)}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

/** The Managed-only fields; the caller owns the surrounding form. */
export function CreateSessionManagedFields({ form }: { form: CreateSessionForm }) {
  return (
    <div className="flex flex-col gap-4" data-testid="managed-create-fields">
      <AgentField form={form} />
      <BaseField form={form} />
      <ProjectSourceField form={form} />
      <ToolchainField form={form} />
      <div
        data-testid="managed-create-workspace"
        className="flex flex-col gap-1 rounded-[var(--nession-radius-surface)] border px-3 py-2"
      >
        <span className={chromeSansRole('secondary')}>Workspace</span>
        <span className="text-muted-foreground">
          Agent-managed durable Workspace created for this Session. The Agent owns its
          bytes; cleanup releases the lease, never the content.
        </span>
      </div>
    </div>
  );
}
