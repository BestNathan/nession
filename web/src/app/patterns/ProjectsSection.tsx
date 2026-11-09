import { FolderKanban, MoreHorizontal, Pencil, Plus, Settings, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarSectionHead } from './SidebarSectionHead';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import type { Project, ProjectShellProps } from '@/product/project/types';

/**
 * Projects in the Web Sidebar and App Sessions layer (#3025).
 *
 * The section is a flat, selectable list below Session history. A Project is a
 * sibling destination, never a parent of the flat Session list; selecting one
 * opens its standalone detail while the current Session stays selected. `+`
 * creates a name-only Project, and the row `···` menu owns rename, settings and
 * the explicit delete confirmation.
 */
export function ProjectNavSection({
  shell,
  variant = 'web',
}: {
  shell: ProjectShellProps;
  variant?: 'web' | 'app';
}) {
  return (
    <section
      data-testid="projects-section"
      data-navigation-section="projects"
      data-variant={variant}
      aria-label="Projects"
      className={cn('flex shrink-0 flex-col', shell.projects.length === 0 && 'pb-1')}
    >
      <SidebarSectionHead
        label="Projects"
        action={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-testid="project-create"
            aria-label="Create Project"
            title="Create Project"
            onClick={() => shell.onCreate()}
            className="size-6 text-muted-foreground hover:text-foreground"
          >
            <Plus className="size-4" aria-hidden />
          </Button>
        }
      />
      <div className="flex min-h-0 flex-col overflow-y-auto pb-1">
        {shell.error ? (
          <div className={cn('flex items-center justify-between gap-2 px-2 py-1 text-destructive', chromeSansRole('secondary'))}>
            <span className="min-w-0 truncate" data-testid="projects-error">
              {shell.error}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => shell.onRetry()}
              data-testid="projects-retry"
            >
              Retry
            </Button>
          </div>
        ) : shell.loading && shell.projects.length === 0 ? (
          <p className={cn('px-2 py-1 text-muted-foreground', chromeSansRole('secondary'))}>
            Loading Projects…
          </p>
        ) : shell.projects.length === 0 ? (
          <p
            data-testid="projects-empty"
            className={cn('px-2 py-1 text-muted-foreground', chromeSansRole('secondary'))}
          >
            No Projects yet
          </p>
        ) : (
          shell.projects.map((project) => (
            <ProjectRow key={project.project_id} project={project} shell={shell} />
          ))
        )}
      </div>
    </section>
  );
}

function ProjectRow({ project, shell }: { project: Project; shell: ProjectShellProps }) {
  const selected = project.project_id === shell.selectedProjectId;
  return (
    <div className="group relative flex items-center">
      <Button
        type="button"
        variant="ghost"
        data-testid="project-item-row"
        data-project-id={project.project_id}
        data-selected={selected ? 'true' : undefined}
        aria-current={selected ? 'page' : undefined}
        onClick={() => shell.onSelect(project)}
        className={cn(
          'h-auto min-w-0 flex-1 justify-start gap-2 rounded-[var(--nession-radius-surface)] px-2 py-1.5 text-left',
          selected && 'bg-accent text-accent-foreground',
        )}
      >
        <FolderKanban className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="flex min-w-0 flex-col">
          <span data-testid="project-item-title" className="truncate">
            {project.name}
          </span>
          <span className={cn('truncate text-muted-foreground', chromeSansRole('caption'))}>
            {project.source ? 'Git Source' : 'No Source'}
          </span>
        </span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              size="icon"
              variant="ghost"
              data-testid={`project-actions-${project.project_id}`}
              aria-label={`Manage ${project.name}`}
              className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground max-lg:size-11"
            />
          }
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem
            data-testid={`project-actions-rename-${project.project_id}`}
            onClick={() => shell.onRename(project)}
          >
            <Pencil />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid={`project-actions-settings-${project.project_id}`}
            onClick={() => shell.onSettings(project)}
          >
            <Settings />
            Settings
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            data-testid={`project-actions-delete-${project.project_id}`}
            onClick={() => shell.onDelete(project)}
          >
            <Trash2 />
            Delete Project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
