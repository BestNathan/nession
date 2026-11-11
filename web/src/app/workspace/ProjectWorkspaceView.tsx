import { Button } from '@/components/ui/button';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { ProjectDetailContent } from '@/product/project/components/ProjectDetail';
import type { WorkspaceViewProps } from '@/app/workspace/workspaceContext';
import { WorkspaceScrollRegion } from '@/app/workspace/layout/workspaceLayout';

/**
 * The focused Session's Project capability view (#3082 SC-05).
 *
 * It reuses the standalone Project detail body and the shell's Project actions;
 * only the related-Session list is supplied from Session context. Opening this
 * view does not change the selected Session, and the App's one header/Back stay
 * with the host.
 */
export function ProjectWorkspace({ ctx }: WorkspaceViewProps) {
  const projectContext = ctx.sessionProject;
  if (!projectContext) {
    return (
      <p className={cn('p-4 text-muted-foreground', chromeSansRole('secondary'))}>
        Project context is unavailable.
      </p>
    );
  }
  const focused = projectContext.focusedProject;
  if (focused.status === 'loading') {
    return (
      <p data-testid="workspace-project-view" className={cn('p-4', chromeSansRole('secondary'))}>
        Loading Project…
      </p>
    );
  }
  if (focused.status !== 'ready') {
    return (
      <div data-testid="workspace-project-view" className="flex flex-col items-start gap-3 p-4">
        <p className={cn('text-destructive', chromeSansRole('secondary'))}>
          This Project is no longer available. The Session and its Terminal are unchanged.
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => projectContext.onAssociate()}>
          Manage association
        </Button>
      </div>
    );
  }
  return (
    <WorkspaceScrollRegion data-testid="workspace-project-view">
      <ProjectDetailContent
        project={focused.project}
        agents={ctx.agents}
        onCreateSession={projectContext.onCreateProjectSession}
        onSettings={projectContext.onProjectSettings}
        sessions={projectContext.relatedSessions}
        onOpenSession={projectContext.onOpenSession}
      />
    </WorkspaceScrollRegion>
  );
}
