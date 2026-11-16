import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ChoiceItemContent } from '@/components/ui/choice-item';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import type { Agent } from '@/types';
import { agentDisplayName } from '@/shared/lib/format';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { EnvFileMultiSelect, refKey } from '@/capabilities/env';
import { useCreateSessionForm } from '@/product/session/hooks/useCreateSessionForm';
import {
  ENV_MODE_OPTIONS,
  ENV_ORIGIN_LABEL,
  type CreateEnvSelectionMode,
} from '@/product/session/model/envSelection';
import type { Project, ProjectLocation } from '@/product/project/types';
import { ProjectLocationDetails } from './CreateSessionParts';

type CreateSessionForm = ReturnType<typeof useCreateSessionForm>;

interface CreateSessionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  agents: Agent[];
  preselectedAgentId?: string | null;
  /**
   * The created Session's id, when the server returned one.
   *
   * Handed over rather than dropped because creating is only half of what the
   * caller needs: the response already carries the identity, and a caller that
   * has to find the new Session again in a refreshed list is guessing at
   * something it was told (#1082).
   */
  onCreated: (sessionId?: string) => void;
  /**
   * When present, this is the Project's Existing-location creation path
   * (#3025): the Agent and directory come from one of the Project's declared
   * Existing Locations, and the optional `project_id` is sent with the create.
   * Absent keeps the global New Session flow unchanged.
   */
  project?: Project | null;
}

function AgentSelect({
  agents,
  value,
  onChange,
  disabled,
}: {
  agents: Agent[];
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  const selectedAgent = agents.find((a) => a.agent_id === value);
  const displayText = selectedAgent ? agentDisplayName(selectedAgent) : 'Select an agent';

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="agent">Agent</Label>
      <Select value={value} onValueChange={(v) => v && onChange(v)} disabled={disabled}>
        <SelectTrigger id="agent" className="w-full">
          <span className={selectedAgent ? '' : 'text-muted-foreground'}>{displayText}</span>
        </SelectTrigger>
        <SelectContent width="content">
          {agents.map((agent) => (
            <SelectItem key={agent.agent_id} value={agent.agent_id} anatomy="resource">
              <ChoiceItemContent
                title={agentDisplayName(agent)}
                meta={
                  agent.display_name && agent.display_name !== agent.hostname
                    ? agent.hostname
                    : undefined
                }
                status={
                  agent.status === 'online'
                    ? 'Online'
                    : agent.status === 'offline'
                      ? 'Offline'
                      : 'Degraded'
                }
                statusTone={agent.status === 'online' ? 'neutral' : 'unavailable'}
              />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ProjectLocationSelect({
  locations,
  agents,
  selectedLocation,
  locationIndex,
  onIndexChange,
  disabled,
}: {
  locations: ProjectLocation[];
  agents: Agent[];
  selectedLocation: ProjectLocation | null;
  locationIndex: number;
  onIndexChange: (index: number) => void;
  disabled: boolean;
}) {
  const selectedAgent = selectedLocation
    ? agents.find((agent) => agent.agent_id === selectedLocation.agent_id)
    : undefined;
  const unavailable = selectedLocation !== null && selectedAgent?.status !== 'online';

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="project-location">Existing Location</Label>
      {locations.length === 0 ? (
        <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
          No Existing Location. Add an Agent directory in Project settings.
        </p>
      ) : (
        <Select
          value={String(locationIndex)}
          onValueChange={(value) => value && onIndexChange(Number(value))}
          disabled={disabled}
        >
          {/* Agent and path are their own lines (#3089). The old single line
              concatenated them, so a long directory could hide the Agent. */}
          <SelectTrigger
            id="project-location"
            size="content"
            className="min-h-10 w-full py-2 [&>span]:min-w-0"
            data-testid="project-location-trigger"
          >
            {selectedLocation ? (
              <ProjectLocationDetails location={selectedLocation} agent={selectedAgent} showStatus />
            ) : (
              <span className="truncate">Select a location</span>
            )}
          </SelectTrigger>
          <SelectContent width="content">
            {locations.map((location, index) => {
              const agent = agents.find((candidate) => candidate.agent_id === location.agent_id);
              return (
                <SelectItem
                  key={`${location.agent_id}:${location.path}`}
                  value={String(index)}
                  anatomy="resource"
                >
                  <ProjectLocationDetails location={location} agent={agent} showStatus />
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      )}
      {unavailable ? (
        <p
          data-testid="project-location-offline"
          className={cn('text-destructive', chromeSansRole('secondary'))}
        >
          This Agent is offline. The Project configuration is preserved; retry when
          the Agent is online.
        </p>
      ) : null}
    </div>
  );
}

function SessionFields({
  nameInputRef,
  sessionName,
  setSessionName,
  loading,
  children,
}: {
  nameInputRef: React.RefObject<HTMLInputElement | null>;
  sessionName: string;
  setSessionName: (value: string) => void;
  loading: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor="name">Session Name</Label>
        <Input
          ref={nameInputRef}
          id="name"
          type="text"
          value={sessionName}
          onChange={(e) => setSessionName(e.target.value)}
          placeholder="my-session"
          disabled={loading}
          autoComplete="off"
        />
      </div>
      {children}
    </>
  );
}

/** The ordinary non-Project create keeps its optional ENV selection (#3649). */
function OptionalEnvField({ form }: { form: CreateSessionForm }) {
  return (
    <div className="flex flex-col gap-2">
      <Label>Env Files (optional)</Label>
      <EnvFileMultiSelect
        files={form.envFiles}
        selected={form.selectedEnv}
        onChange={form.setSelectedEnv}
        disabled={form.loading}
        emptyLabel="No env files — create one in Env Files"
        /* The roomy dialog can show more than the old 160px nested list. */
        listClassName="h-56"
      />
    </div>
  );
}

function EnvModeChoice({
  value,
  title,
  description,
  selected,
  disabled,
  onSelect,
}: {
  value: CreateEnvSelectionMode;
  title: string;
  description: string;
  selected: boolean;
  disabled: boolean;
  onSelect: (value: CreateEnvSelectionMode) => void;
}) {
  return (
    <label
      data-testid={`env-mode-${value}`}
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-[var(--nession-radius-surface)] border px-3 py-2 transition-colors',
        selected ? 'border-primary bg-primary/10' : 'border-input',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <input
        type="radio"
        name="env-selection-mode"
        value={value}
        checked={selected}
        disabled={disabled}
        onChange={() => onSelect(value)}
        className="mt-0.5 size-4 accent-primary"
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={chromeSansRole('primary')}>{title}</span>
        <span className={cn('text-muted-foreground', chromeSansRole('caption'))}>
          {description}
        </span>
      </span>
    </label>
  );
}

/** The effective selection and its origin, before Submit (#3649). */
function EffectiveEnvPreview({ form }: { form: CreateSessionForm }) {
  const { effectiveEnv, unavailableEnv } = form;
  return (
    <div
      data-testid="env-effective-preview"
      className="flex flex-col gap-1 rounded-[var(--nession-radius-surface)] border px-3 py-2"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className={chromeSansRole('secondary')}>Effective Session environment</span>
        <span
          data-testid="env-effective-origin"
          className={cn('text-muted-foreground', chromeSansRole('caption'))}
        >
          {ENV_ORIGIN_LABEL[effectiveEnv.origin]}
        </span>
      </div>
      {effectiveEnv.refs.length === 0 ? (
        <p
          data-testid="env-effective-empty"
          className={cn('text-muted-foreground', chromeSansRole('metadata'))}
        >
          No ENV files will be bound.
        </p>
      ) : (
        <ol data-testid="env-effective-list" className="flex flex-col gap-0.5">
          {effectiveEnv.refs.map((ref, index) => (
            <li
              key={`${refKey(ref)}-${index}`}
              data-testid={`env-effective-item-${index}`}
              className={cn('flex min-w-0 items-baseline gap-1.5', chromeSansRole('metadata'))}
            >
              <span className="w-4 shrink-0 text-muted-foreground">{index + 1}.</span>
              <span className="min-w-0 break-words">{ref.name}</span>
              {unavailableEnv.some((candidate) => refKey(candidate) === refKey(ref)) ? (
                <span
                  data-testid={`env-effective-missing-${index}`}
                  className="shrink-0 text-destructive"
                >
                  missing
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * The Project branch's three explicit choices (#3649): inherit, an explicit
 * custom replacement, or an explicit empty replacement. `No environment` is a
 * real choice, not "nothing selected" — the legacy empty `env_files` means
 * inherit, so only the explicit mode can bind zero files against Project
 * defaults.
 */
function ProjectEnvField({ form }: { form: CreateSessionForm }) {
  return (
    <div className="flex flex-col gap-2">
      <Label>Environment</Label>
      <div
        role="radiogroup"
        aria-label="Session environment selection"
        className="flex flex-col gap-2"
      >
        {ENV_MODE_OPTIONS.map((option) => (
          <EnvModeChoice
            key={option.value}
            value={option.value}
            title={option.title}
            description={option.description}
            selected={form.envSelectionMode === option.value}
            disabled={form.loading}
            onSelect={form.setEnvSelectionMode}
          />
        ))}
      </div>
      <EffectiveEnvPreview form={form} />
      {form.envSelectionMode === 'custom' ? (
        <EnvFileMultiSelect
          files={form.envFiles}
          selected={form.selectedEnv}
          onChange={form.setSelectedEnv}
          disabled={form.loading}
          emptyLabel="No env files — create one in Env Files"
          listClassName="h-56"
          reorderable
          catalogReady={form.envCatalogState === 'ready'}
        />
      ) : null}
    </div>
  );
}

export function CreateSessionDialog({
  isOpen,
  onClose,
  agents,
  preselectedAgentId,
  onCreated,
  project,
}: CreateSessionDialogProps) {
  const form = useCreateSessionForm({
    isOpen,
    agents,
    preselectedAgentId,
    project,
    onCreated,
    onClose,
  });

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="standard" data-testid="create-session-dialog">
        <DialogHeader>
          <DialogTitle>
            {project ? `Create Session in “${project.name}”` : 'Create Session'}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <DialogBody className="flex flex-col gap-4">
            {project ? (
              <ProjectLocationSelect
                locations={form.locations}
                agents={agents}
                selectedLocation={form.selectedLocation}
                locationIndex={form.locationIndex}
                onIndexChange={form.setLocationIndex}
                disabled={form.loading}
              />
            ) : (
              <AgentSelect
                agents={form.onlineAgents}
                value={form.agentId}
                onChange={form.setAgentId}
                disabled={form.loading}
              />
            )}
            <SessionFields
              nameInputRef={form.nameInputRef}
              sessionName={form.sessionName}
              setSessionName={form.setSessionName}
              loading={form.loading}
            >
              {project ? (
                <ProjectEnvField form={form} />
              ) : (
                <OptionalEnvField form={form} />
              )}
            </SessionFields>
            {form.error && (
              <p className={cn('text-destructive', chromeSansRole('body'))} data-testid="create-session-error">
                {form.error}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onClose()} disabled={form.loading}>
              Cancel
            </Button>
            <Button
              type="submit"
              data-testid="create-session-submit"
              disabled={
                form.loading ||
                (project ? !form.selectedLocation || form.locationUnavailable : !form.agentId)
              }
            >
              {form.loading ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
