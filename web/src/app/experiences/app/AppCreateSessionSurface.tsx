import { useEffect, useState, type ReactNode } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { agentDisplayName } from '@/shared/lib/format';
import { bodyAppClass, secondaryAppClass } from './appTypography';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EnvFileMultiSelect } from '@/capabilities/env';
import type { Agent, EnvFileRef } from '@/types';
import { useCreateSessionForm } from '@/product/session/hooks/useCreateSessionForm';
import type { Project, ProjectLocation } from '@/product/project/types';
import { ProjectLocationDetails } from '@/product/session/components/CreateSessionParts';
import { AppOperationPage } from './AppOperationPage';

type Phase = 'form' | 'location' | 'agent' | 'env';
type CreateForm = ReturnType<typeof useCreateSessionForm>;

function DoneButton({ testId, onClick }: { testId: string; onClick: () => void }) {
  return (
    <Button type="button" data-testid={testId} className="min-h-11 w-full" onClick={onClick}>
      Done
    </Button>
  );
}

function AppCreateLocationPage({
  form,
  agents,
  onBack,
}: {
  form: CreateForm;
  agents: Agent[];
  onBack: () => void;
}) {
  return (
    <AppOperationPage
      testId="app-create-location-page"
      title="Existing location"
      backLabel="New Session"
      onBack={onBack}
      footer={<DoneButton testId="app-create-location-done" onClick={onBack} />}
    >
      {form.locations.map((location: ProjectLocation, index: number) => {
        const agent = agents.find((candidate) => candidate.agent_id === location.agent_id);
        const selected = index === form.locationIndex;
        return (
          <button
            key={`${location.agent_id}:${location.path}`}
            type="button"
            data-testid={`app-create-location-${index}`}
            aria-pressed={selected}
            className={cn(
              'flex min-h-11 w-full items-start gap-2 rounded-[var(--nession-radius-surface)] border px-3 py-2 text-left',
              selected ? 'border-primary bg-primary/10' : 'border-input',
            )}
            onClick={() => form.setLocationIndex(index)}
          >
            <span
              className={cn(
                'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
                selected ? 'border-primary bg-primary' : 'border-muted-foreground/40',
              )}
              aria-hidden
            >
              {selected ? <Check className="size-3 text-primary-foreground" /> : null}
            </span>
            <ProjectLocationDetails location={location} agent={agent} showStatus />
          </button>
        );
      })}
      {form.locations.length === 0 ? (
        <p className={cn('text-muted-foreground', secondaryAppClass)}>
          No Existing Location. Add an Agent directory in Project settings.
        </p>
      ) : null}
    </AppOperationPage>
  );
}

function AppCreateAgentPage({
  form,
  onBack,
}: {
  form: CreateForm;
  onBack: () => void;
}) {
  return (
    <AppOperationPage
      testId="app-create-agent-page"
      title="Agent"
      backLabel="New Session"
      onBack={onBack}
      footer={<DoneButton testId="app-create-agent-done" onClick={onBack} />}
    >
      {form.onlineAgents.map((agent, index) => {
        const selected = agent.agent_id === form.agentId;
        return (
          <button
            key={agent.agent_id}
            type="button"
            data-testid={`app-create-agent-${index}`}
            aria-pressed={selected}
            className={cn(
              'flex min-h-11 w-full items-center gap-2 rounded-[var(--nession-radius-surface)] border px-3 py-2 text-left',
              selected ? 'border-primary bg-primary/10' : 'border-input',
            )}
            onClick={() => form.setAgentId(agent.agent_id)}
          >
            <span
              className={cn(
                'flex size-4 shrink-0 items-center justify-center rounded-full border',
                selected ? 'border-primary bg-primary' : 'border-muted-foreground/40',
              )}
              aria-hidden
            >
              {selected ? <Check className="size-3 text-primary-foreground" /> : null}
            </span>
            <span className={bodyAppClass}>{agentDisplayName(agent)}</span>
          </button>
        );
      })}
    </AppOperationPage>
  );
}

function AppCreateEnvPage({ form, onBack }: { form: CreateForm; onBack: () => void }) {
  return (
    <AppOperationPage
      testId="app-create-env-page"
      title="Environment files"
      backLabel="New Session"
      onBack={onBack}
      footer={<DoneButton testId="app-create-env-done" onClick={onBack} />}
    >
      <EnvFileMultiSelect
        files={form.envFiles}
        selected={form.selectedEnv}
        onChange={(selected: EnvFileRef[]) => form.setSelectedEnv(selected)}
        disabled={form.loading}
        emptyLabel="No env files — create one in Env Files"
        scroll={false}
      />
    </AppOperationPage>
  );
}

function ChooseRow({
  testId,
  label,
  value,
  onClick,
}: {
  testId: string;
  label: string;
  value: ReactNode;
  onClick: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label>{label}</Label>
      <button
        type="button"
        data-testid={testId}
        className="flex min-h-11 w-full items-center justify-between gap-2 rounded-[var(--nession-radius-surface)] border px-3 py-2 text-left"
        onClick={onClick}
      >
        <span className="min-w-0 flex-1">{value}</span>
        <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </button>
    </div>
  );
}

function AppCreateFields({
  form,
  project,
  agents,
  onPhase,
}: {
  form: CreateForm;
  project?: Project | null;
  agents: Agent[];
  onPhase: (phase: Phase) => void;
}) {
  const selectedAgent = form.selectedLocation
    ? agents.find((agent) => agent.agent_id === form.selectedLocation?.agent_id)
    : undefined;
  const envSummary = form.selectedEnv.length > 0
    ? form.selectedEnv.map((ref) => ref.name).join(', ')
    : 'Optional · None selected';

  return (
    <form
      id="app-create-session-form"
      className="flex flex-col gap-[var(--nession-shell-space-3)]"
      onSubmit={form.handleSubmit}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="name">Session Name</Label>
        <Input
          ref={form.nameInputRef}
          id="name"
          type="text"
          value={form.sessionName}
          onChange={(event) => form.setSessionName(event.target.value)}
          placeholder="my-session"
          disabled={form.loading}
          autoComplete="off"
          data-testid="app-session-name"
        />
      </div>
      {project ? (
        <>
          <ChooseRow
            testId="app-session-location"
            label="Existing location"
            value={
              form.selectedLocation ? (
                <ProjectLocationDetails
                  location={form.selectedLocation}
                  agent={selectedAgent}
                  showStatus
                />
              ) : (
                <span className={secondaryAppClass}>Select a location</span>
              )
            }
            onClick={() => onPhase('location')}
          />
          {form.locationUnavailable ? (
            <p
              className={cn('text-destructive', secondaryAppClass)}
              data-testid="app-session-location-offline"
            >
              This Agent is offline. The Project configuration is preserved; retry when
              the Agent is online.
            </p>
          ) : null}
        </>
      ) : (
        <ChooseRow
          testId="app-session-agent"
          label="Agent"
          value={
            <span className={bodyAppClass}>
              {form.agentId
                ? agentDisplayName(
                    agents.find((agent) => agent.agent_id === form.agentId) ?? {
                      agent_id: form.agentId,
                      hostname: form.agentId,
                    } as Agent,
                  )
                : 'Select an Agent'}
            </span>
          }
          onClick={() => onPhase('agent')}
        />
      )}
      <ChooseRow
        testId="app-session-env"
        label="Environment files"
        value={
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className={bodyAppClass}>Environment files</span>
            <span className={cn('break-words text-muted-foreground', secondaryAppClass)}>
              {envSummary}
            </span>
          </span>
        }
        onClick={() => onPhase('env')}
      />
      {form.error ? (
        <p className={cn('text-destructive', bodyAppClass)} data-testid="create-session-error">
          {form.error}
        </p>
      ) : null}
    </form>
  );
}

function AppCreateFormPage({
  form,
  project,
  agents,
  onBack,
  onPhase,
}: {
  form: CreateForm;
  project?: Project | null;
  agents: Agent[];
  onBack: () => void;
  onPhase: (phase: Phase) => void;
}) {
  return (
    <AppOperationPage
      testId="app-create-session-page"
      title="New Session"
      backLabel={project ? project.name : 'Sessions'}
      onBack={onBack}
      footer={
        <Button
          type="button"
          data-testid="create-session-submit"
          disabled={
            form.loading ||
            (project ? !form.selectedLocation || form.locationUnavailable : !form.agentId)
          }
          className="min-h-11 w-full"
          onClick={() => void form.submit()}
        >
          {form.loading ? 'Creating...' : 'Create Session'}
        </Button>
      }
    >
      <AppCreateFields form={form} project={project} agents={agents} onPhase={onPhase} />
    </AppOperationPage>
  );
}

/**
 * App Session creation (#3089).
 *
 * A full-height operation page, not a centered dialog: Session name, one
 * Existing-Location (or Agent) choice and the ENV summary on the page; the
 * Location/Agent and ENV lists are child depths of the same operation. Back
 * from a child returns to the draft with its value intact; Back from the form
 * returns to the originating Project/Sessions context without creating.
 *
 * The form state, validation and create call are `useCreateSessionForm`, the
 * same owner the Web dialog uses.
 */
export function AppCreateSessionSurface({
  isOpen,
  project,
  agents,
  onClose,
  onCreated,
}: {
  isOpen: boolean;
  project?: Project | null;
  agents: Agent[];
  onClose: () => void;
  onCreated: (sessionId?: string) => void;
}) {
  const form = useCreateSessionForm({
    isOpen,
    agents,
    project: project ?? null,
    onCreated,
    onClose,
  });
  const [phase, setPhase] = useState<Phase>('form');

  useEffect(() => {
    if (isOpen) {
      setPhase('form');
    }
  }, [isOpen, project?.project_id]);

  if (!isOpen) {
    return null;
  }

  if (phase === 'location') {
    return <AppCreateLocationPage form={form} agents={agents} onBack={() => setPhase('form')} />;
  }
  if (phase === 'agent') {
    return <AppCreateAgentPage form={form} onBack={() => setPhase('form')} />;
  }
  if (phase === 'env') {
    return <AppCreateEnvPage form={form} onBack={() => setPhase('form')} />;
  }
  return (
    <AppCreateFormPage
      form={form}
      project={project}
      agents={agents}
      onBack={onClose}
      onPhase={setPhase}
    />
  );
}
