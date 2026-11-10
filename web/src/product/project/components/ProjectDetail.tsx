import { useState } from 'react';
import { Boxes, GitBranch, MapPin, Plus, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DetailEmpty,
  DetailFact,
  DetailFacts,
  DetailGroup,
  DetailHeader,
  DetailNote,
  DetailSection,
  DetailSurface,
} from '@/components/ui/resource-detail';
import { detailInteractiveRowClass, detailRowClass } from '@/components/ui/resource-detailStyles';
import { cn } from '@/shared/lib/utils';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { agentDisplayName } from '@/shared/lib/format';
import type { Agent, Session } from '@/types';
import type { Project, ProjectLocation } from '@/product/project/types';

export interface ProjectDetailProps {
  project: Project;
  agents: Agent[];
  onCreateSession: (project: Project) => void;
  onSettings: (project: Project) => void;
  /** Related Sessions are a Workspace-content projection, not navigation (#3082). */
  sessions?: Session[];
  onOpenSession?: (session: Session) => void;
  /**
   * `heading` is a surface that names itself (Web destination). `context`
   * omits the repeated identity when the host's one App page header already
   * names the Project (#1051, #3137 SC-03).
   */
  identity?: 'heading' | 'context';
}

function LocationRow({ agents, location }: { agents: Agent[]; location: ProjectLocation }) {
  const agent = agents.find((candidate) => candidate.agent_id === location.agent_id);
  const online = agent?.status === 'online';
  return (
    <div
      data-testid="project-location-row"
      data-recipe-part="detail-row"
      className={detailRowClass}
    >
      <MapPin className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className={chromeSansRole('primary')}>
          {agent ? agentDisplayName(agent) : location.agent_id}
        </span>
        <span className={cn('break-all text-muted-foreground', chromeMonoRole('metadata'))}>
          {location.path}
        </span>
      </div>
      <span
        data-testid="project-location-status"
        className={cn(
          chromeSansRole('caption'),
          online ? 'text-agent-online' : 'text-agent-offline',
        )}
      >
        {online ? 'Online' : 'Offline'}
      </span>
    </div>
  );
}

function ProjectHeader({
  project,
  identity,
  onCreateSession,
  onManagedUnavailable,
  onSettings,
}: {
  project: Project;
  identity: 'heading' | 'context';
  onCreateSession: (project: Project) => void;
  onManagedUnavailable: () => void;
  onSettings: (project: Project) => void;
}) {
  const heading = identity === 'heading';
  return (
    <DetailHeader
      eyebrow={heading ? 'Project' : undefined}
      title={heading ? project.name : undefined}
      titleTestId={heading ? 'project-detail-title' : undefined}
      level={heading ? 'h1' : 'h2'}
      description={project.description}
      actions={
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid="project-detail-settings"
          aria-label="Project settings"
          title="Project settings"
          onClick={() => onSettings(project)}
        >
          <Settings className="size-4" aria-hidden />
        </Button>
      }
    >
      <Button
        type="button"
        data-testid="project-detail-create-session"
        onClick={() => onCreateSession(project)}
      >
        <Plus className="size-4" aria-hidden />
        New Session
      </Button>
      <Button
        type="button"
        variant="outline"
        data-testid="project-detail-managed-session"
        onClick={() => onManagedUnavailable()}
      >
        <Boxes className="size-4" aria-hidden />
        Managed (EROFS)
      </Button>
      <span className={cn('text-muted-foreground', chromeSansRole('caption'))}>
        Project is a declaration; the Session owns its runtime and environment.
      </span>
    </DetailHeader>
  );
}

function SourceSection({ project }: { project: Project }) {
  return (
    <DetailSection title="Git source">
      {project.source ? (
        <DetailFacts className="gap-1.5">
          <DetailFact
            label="Repository"
            mono
            valueTestId="project-source-repository"
          >
            <span className="flex items-start gap-2">
              <GitBranch className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span>{project.source.repository_url}</span>
            </span>
          </DetailFact>
          <DetailFact label="Ref" mono inline>
            <span data-testid="project-source-ref">{project.source.ref}</span>
          </DetailFact>
        </DetailFacts>
      ) : (
        <DetailEmpty>No Git source configured.</DetailEmpty>
      )}
    </DetailSection>
  );
}

function LocationsSection({ project, agents }: { project: Project; agents: Agent[] }) {
  return (
    <DetailSection title="Existing Locations">
      {project.locations.length > 0 ? (
        <DetailGroup>
          {project.locations.map((location) => (
            <LocationRow
              key={`${location.agent_id}:${location.path}`}
              agents={agents}
              location={location}
            />
          ))}
        </DetailGroup>
      ) : (
        <DetailEmpty>
          No Existing Locations. Add an Agent directory in Project settings before
          creating an Existing Session.
        </DetailEmpty>
      )}
    </DetailSection>
  );
}

function DefaultsSection({ project }: { project: Project }) {
  const defaults = project.session_defaults;
  return (
    <DetailSection title="Session defaults">
      {defaults ? (
        <>
          <DetailFacts className="gap-1">
            <DetailFact label="Shell" mono inline>
              {defaults.shell ?? 'Unset'}
            </DetailFact>
            <DetailFact label="Env profiles" mono inline>
              {defaults.env_profile_ids.length > 0
                ? defaults.env_profile_ids.join(', ')
                : 'None'}
            </DetailFact>
            <DetailFact label="Sandbox policy" mono inline>
              {defaults.sandbox_policy_ref ?? 'Unset'}
            </DetailFact>
          </DetailFacts>
          <DetailNote>
            Desired defaults only. Session creation owns the realized environment.
          </DetailNote>
        </>
      ) : (
        <DetailEmpty>No Session defaults.</DetailEmpty>
      )}
    </DetailSection>
  );
}

function RelatedSessionsSection({
  sessions,
  onOpenSession,
}: {
  sessions: Session[];
  onOpenSession?: (session: Session) => void;
}) {
  return (
    <DetailSection title="Related Sessions">
      {sessions.length > 0 ? (
        <DetailGroup>
          {sessions.map((session) => (
            <button
              key={session.session_id}
              type="button"
              data-testid="project-related-session"
              data-recipe-part="detail-row-button"
              className={cn(detailInteractiveRowClass, 'justify-between gap-2')}
              onClick={() => onOpenSession?.(session)}
            >
              <span className="flex min-w-0 flex-col">
                <span className={cn('truncate', chromeSansRole('primary'))}>
                  {session.session_name}
                </span>
                <span className={cn('truncate text-muted-foreground', chromeSansRole('caption'))}>
                  {session.agent_id}
                </span>
              </span>
              <span className={cn('text-muted-foreground', chromeSansRole('caption'))}>
                Open
              </span>
            </button>
          ))}
        </DetailGroup>
      ) : (
        <DetailEmpty>No other Sessions are associated with this Project.</DetailEmpty>
      )}
    </DetailSection>
  );
}

function ImageSection({ project }: { project: Project }) {
  return (
    <DetailSection title="Image">
      {project.image_digest ? (
        <DetailFact label="Image digest" mono valueTestId="project-image-digest">
          {project.image_digest}
        </DetailFact>
      ) : (
        <DetailEmpty>
          No image digest. Shared EROFS artifacts are referenced by immutable digest
          through the global Image Manager.
        </DetailEmpty>
      )}
    </DetailSection>
  );
}

/** A fail-closed Managed entry: the EROFS/Sandbox runtime does not exist yet. */
function ManagedUnavailableDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="project-managed-unavailable">
        <DialogHeader>
          <DialogTitle>Managed Session is not available yet</DialogTitle>
        </DialogHeader>
        <p className={chromeSansRole('secondary')}>
          A Managed Session needs the native EROFS/Sandbox runtime, which this
          Server does not provide yet. Nothing was created and no Native
          fallback was attempted. The Project configuration is preserved.
        </p>
        <DialogFooter>
          <Button type="button" onClick={() => onClose()}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The standalone Project detail body, shared by Web and App (#3025). */
export function ProjectDetailContent({
  project,
  agents,
  onCreateSession,
  onSettings,
  sessions,
  onOpenSession,
  identity = 'heading',
}: ProjectDetailProps) {
  const [managedOpen, setManagedOpen] = useState(false);
  return (
    <DetailSurface
      data-testid="project-detail"
      data-project-id={project.project_id}
      className={cn('mx-auto max-w-3xl px-4 py-4')}
    >
      <ProjectHeader
        project={project}
        identity={identity}
        onCreateSession={onCreateSession}
        onManagedUnavailable={() => setManagedOpen(true)}
        onSettings={onSettings}
      />
      <SourceSection project={project} />
      <LocationsSection project={project} agents={agents} />
      <DefaultsSection project={project} />
      {sessions === undefined ? null : (
        <RelatedSessionsSection sessions={sessions} onOpenSession={onOpenSession} />
      )}
      <ImageSection project={project} />
      <ManagedUnavailableDialog open={managedOpen} onClose={() => setManagedOpen(false)} />
    </DetailSurface>
  );
}

/** Web: the Project detail is a main-region destination independent of Session. */
export function ProjectDetail(props: ProjectDetailProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <ProjectDetailContent {...props} />
    </div>
  );
}
