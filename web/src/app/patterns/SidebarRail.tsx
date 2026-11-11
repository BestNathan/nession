import type { ReactNode, RefObject } from 'react';
import { Check, FolderOpen, PanelLeftOpen, Plus, Search } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SERVER_LABEL } from '@/app/patterns/serverStatusLabel';
import type { ProjectShellProps } from '@/product/project/types';
import type { ConnectionState } from '@/platform/socket/types';
import { shellIconButtonClass, shellIconFocusClass, shellMotionClass } from '@/app/shellStyles';

const railButtonClass = cn(
  shellIconButtonClass,
  shellIconFocusClass,
  'rounded-[var(--nession-radius-control)] text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50',
);

function RailButton({
  testId,
  label,
  onClick,
  disabled,
  buttonRef,
  children,
}: {
  testId: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  buttonRef?: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      ref={buttonRef}
      data-testid={testId}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onClick()}
      className={railButtonClass}
    >
      {children}
    </button>
  );
}

/**
 * The collapsed Web navigation column (#3075).
 *
 * A reserved, in-flow 56px rail — not a floating control over the work
 * surface. It keeps the shell's shortcuts reachable without exposing the
 * Session list: one Expand, New Session, Search Sessions, a Projects menu only
 * when Projects are actually navigable, and a passive Server status. Every
 * action delegates to its existing owner; the rail introduces no parallel
 * search, creation, Project or connection state.
 */
export function SidebarRail({
  onExpand,
  onCreate,
  createDisabled,
  onSearch,
  connectionStatus,
  projectShell,
  expandRef,
}: {
  onExpand: () => void;
  onCreate: () => void;
  createDisabled: boolean;
  onSearch: () => void;
  connectionStatus: ConnectionState;
  projectShell: ProjectShellProps;
  expandRef?: RefObject<HTMLButtonElement | null>;
}) {
  const projects = projectShell.projects;
  return (
    <aside
      data-testid="sidebar-rail"
      aria-label="Quick navigation"
      className={cn(
        'bg-sidebar flex h-full w-[length:var(--nession-shell-rail-width)] shrink-0 flex-col items-center gap-[var(--nession-shell-space-1)] py-[var(--nession-shell-space-2)]',
        shellMotionClass,
      )}
    >
      <RailButton testId="sidebar-rail-expand" label="Expand sidebar" onClick={onExpand} buttonRef={expandRef}>
        <PanelLeftOpen className="size-[length:var(--nession-icon-md)]" aria-hidden />
      </RailButton>
      <div className="my-[var(--nession-shell-space-1)] h-px w-[calc(var(--nession-shell-icon-button-size)-var(--nession-shell-space-4))] bg-border" aria-hidden />
      <RailButton
        testId="sidebar-rail-new-session"
        label={createDisabled ? 'New Session (no online Agent)' : 'New Session'}
        onClick={onCreate}
        disabled={createDisabled}
      >
        <Plus className="size-[length:var(--nession-icon-md)]" aria-hidden />
      </RailButton>
      <RailButton testId="sidebar-rail-search" label="Search sessions" onClick={onSearch}>
        <Search className="size-[length:var(--nession-icon-md)]" aria-hidden />
      </RailButton>
      {projects.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            data-testid="sidebar-rail-projects"
            aria-label="Projects"
            title="Projects"
            className={railButtonClass}
          >
            <FolderOpen className="size-[length:var(--nession-icon-md)]" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start" className="w-56">
            {projects.map((project) => (
              <DropdownMenuItem
                key={project.project_id}
                data-testid={`sidebar-rail-project-${project.project_id}`}
                onClick={() => projectShell.onSelect(project)}
              >
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                {project.project_id === projectShell.selectedProjectId ? (
                  <Check className="size-4 shrink-0" aria-hidden />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <div className="mt-auto flex w-full flex-col items-center gap-[var(--nession-shell-space-1)] pb-[var(--nession-shell-space-2)]">
        <span
          data-testid="sidebar-rail-server"
          role="img"
          aria-label={SERVER_LABEL[connectionStatus]}
          title={SERVER_LABEL[connectionStatus]}
          className={cn(
            'flex size-[length:var(--nession-shell-icon-button-size)] items-center justify-center',
          )}
        >
          <span
            data-testid="sidebar-rail-server-dot"
            aria-hidden="true"
            className={cn(
              'size-[length:var(--nession-shell-status-dot-size)] rounded-full',
              connectionStatus === 'connected' ? 'bg-[var(--nession-action)]' : 'bg-destructive',
            )}
          />
        </span>
      </div>
    </aside>
  );
}
