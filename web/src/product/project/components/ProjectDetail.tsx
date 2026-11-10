import { useState } from 'react';
import { Boxes, GitBranch, MapPin, Plus, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/shared/lib/utils';
import { chromeLabelRole, chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
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
}

const boxClass = 'rounded-[var(--nession-radius-surface)] border border-border px-3 py-2';

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className={chromeSansRole('secondary')}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return (
    <p
      className={cn(
        'rounded-[var(--nession-radius-surface)] border border-dashed border-border px-3 py-3 text-muted-foreground',
        chromeSansRole('secondary'),
      )}
    >
      {children}
    </p>
  );
}

function LocationRow({ agents, location }: { agents: Agent[]; location: ProjectLocation }) {
  const agent = agents.find((candidate) => candidate.agent_id === location.agent_id);
  const online = agent?.status === 'online';
  return (
    <div
      data-testid="project-location-row"
      className={cn(boxClass, 'flex items-center gap-2')}
    >
      <MapPin className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className={chromeSansRole('primary')}>
          {agent ? agentDisplayName(agent) : location.agent_id}
        </span>
        <span className={cn('truncate text-muted-foreground', chromeMonoRole('metadata'))}>
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
  onCreateSession,
  onManagedUnavailable,
  onSettings,
}: {
  project: Project;
  onCreateSession: (project: Project) => void;
  onManagedUnavailable: () => void;
  onSettings: (project: Project) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className={cn('text-muted-foreground', chromeLabelRole('caption'))}>Project</p>
          <h1 data-testid="project-detail-title" className={cn('truncate', chromeSansRole('primary'))}>
            {project.name}
          </h1>
          {project.description ? (
            <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
              {project.description}
            </p>
          ) : null}
        </div>
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
      </div>
      <div className="flex flex-wrap items-center gap-2">
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
      </div>
    </div>
  );
}

function SourceSection({ project }: { project: Project }) {
  return (
    <Section title="Git Source">
      {project.source ? (
        <div className={cn(boxClass, 'flex flex-col gap-1')}>
          <span className="flex items-center gap-2 break-all">
            <GitBranch className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className={chromeMonoRole('metadata')}>{project.source.repository_url}</span>
          </span>
          <span className={cn('text-muted-foreground', chromeSansRole('caption'))}>
            Ref · <span data-testid="project-source-ref">{project.source.ref}</span>
          </span>
        </div>
      ) : (
        <EmptyRow>No Git source configured.</EmptyRow>
      )}
    </Section>
  );
}

function LocationsSection({ project, agents }: { project: Project; agents: Agent[] }) {
  return (
    <Section title="Existing Locations">
      {project.locations.length > 0 ? (
        <div className="flex flex-col gap-2">
          {project.locations.map((location) => (
            <LocationRow
              key={`${location.agent_id}:${location.path}`}
              agents={agents}
              location={location}
            />
          ))}
        </div>
      ) : (
        <EmptyRow>
          No Existing Locations. Add an Agent directory in Project settings before
          creating an Existing Session.
        </EmptyRow>
      )}
    </Section>
  );
}

function DefaultsSection({ project }: { project: Project }) {
  const defaults = project.session_defaults;
  return (
    <Section title="Session defaults">
      {defaults ? (
        <div className={cn(boxClass, 'flex flex-col gap-1')}>
          <span className={chromeSansRole('secondary')}>
            Shell · <span className={chromeMonoRole('metadata')}>{defaults.shell ?? 'Unset'}</span>
          </span>
          <span className={chromeSansRole('secondary')}>
            Env profiles ·{' '}
            <span className={chromeMonoRole('metadata')}>
              {defaults.env_profile_ids.length > 0 ? defaults.env_profile_ids.join(', ') : 'None'}
            </span>
          </span>
          <span className={chromeSansRole('secondary')}>
            Sandbox policy ·{' '}
            <span className={chromeMonoRole('metadata')}>
              {defaults.sandbox_policy_ref ?? 'Unset'}
            </span>
          </span>
          <span className={cn('text-muted-foreground', chromeSansRole('caption'))}>
            Desired defaults only. Session creation owns the realized environment.
          </span>
        </div>
      ) : (
        <EmptyRow>No Session defaults.</EmptyRow>
      )}
    </Section>
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
    <Section title="Related Sessions">
      {sessions.length > 0 ? (
        <div className="flex flex-col gap-2">
          {sessions.map((session) => (
            <button
              key={session.session_id}
              type="button"
              data-testid="project-related-session"
              className={cn(boxClass, 'flex min-w-0 items-center justify-between gap-2 text-left')}
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
        </div>
      ) : (
        <EmptyRow>No other Sessions are associated with this Project.</EmptyRow>
      )}
    </Section>
  );
}

function ImageSection({ project }: { project: Project }) {
  return (
    <Section title="Image">
      {project.image_digest ? (
        <p
          data-testid="project-image-digest"
          className={cn('break-all', boxClass, chromeMonoRole('metadata'))}
        >
          {project.image_digest}
        </p>
      ) : (
        <EmptyRow>
          No image digest. Shared EROFS artifacts are referenced by immutable digest
          through the global Image Manager.
        </EmptyRow>
      )}
    </Section>
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
}: ProjectDetailProps) {
  const [managedOpen, setManagedOpen] = useState(false);
  return (
    <div
      data-testid="project-detail"
      data-project-id={project.project_id}
      className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-4 py-4"
    >
      <ProjectHeader
        project={project}
        onCreateSession={onCreateSession}
        onManagedUnavailable={() => setManagedOpen(true)}
        onSettings={onSettings}
      />
      <Separator />
      <SourceSection project={project} />
      <LocationsSection project={project} agents={agents} />
      <DefaultsSection project={project} />
      {sessions === undefined ? null : (
        <RelatedSessionsSection sessions={sessions} onOpenSession={onOpenSession} />
      )}
      <ImageSection project={project} />
      <ManagedUnavailableDialog open={managedOpen} onClose={() => setManagedOpen(false)} />
    </div>
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
