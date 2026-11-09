import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import type { Agent, EnvFileInfo, EnvFileRef } from '@/types';
import { agentDisplayName } from '@/shared/lib/format';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { EnvFileMultiSelect } from '@/capabilities/env';
import { useCreateSessionForm } from '@/product/session/hooks/useCreateSessionForm';
import type { Project, ProjectLocation } from '@/product/project/types';
import { ProjectLocationDetails } from './CreateSessionParts';

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
        <SelectContent>
          {agents.map((agent) => (
            <SelectItem key={agent.agent_id} value={agent.agent_id}>
              {agentDisplayName(agent)}
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
          <SelectContent>
            {locations.map((location, index) => {
              const agent = agents.find((candidate) => candidate.agent_id === location.agent_id);
              return (
                <SelectItem
                  key={`${location.agent_id}:${location.path}`}
                  value={String(index)}
                  multiline
                >
                  <ProjectLocationDetails location={location} agent={agent} />
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
  envFiles,
  selectedEnv,
  setSelectedEnv,
  loading,
}: {
  nameInputRef: React.RefObject<HTMLInputElement | null>;
  sessionName: string;
  setSessionName: (value: string) => void;
  envFiles: EnvFileInfo[];
  selectedEnv: EnvFileRef[];
  setSelectedEnv: (value: EnvFileRef[]) => void;
  loading: boolean;
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
      <div className="flex flex-col gap-2">
        <Label>Env Files (optional)</Label>
        <EnvFileMultiSelect
          files={envFiles}
          selected={selectedEnv}
          onChange={setSelectedEnv}
          disabled={loading}
          emptyLabel="No env files — create one in Env Files"
          /* The roomy dialog can show more than the old 160px nested list. */
          listClassName="h-56"
        />
      </div>
    </>
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
      <DialogContent className="sm:max-w-[40rem]" data-testid="create-session-dialog">
        <DialogHeader className="sticky top-0 z-10 -mx-4 bg-popover px-4 pb-2">
          <DialogTitle>
            {project ? `Create Session in “${project.name}”` : 'Create Session'}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit} className="flex flex-col gap-4">
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
            envFiles={form.envFiles}
            selectedEnv={form.selectedEnv}
            setSelectedEnv={form.setSelectedEnv}
            loading={form.loading}
          />
          {form.error && (
            <p className={cn('text-destructive', chromeSansRole('body'))} data-testid="create-session-error">
              {form.error}
            </p>
          )}
          <DialogFooter sticky>
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
