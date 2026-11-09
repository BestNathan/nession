import type {
  Project,
  ProjectLocation,
  ProjectSessionDefaults,
  ProjectSource,
} from '@/generated/protocol/core/server-project-list/v1';

export type { Project, ProjectLocation, ProjectSessionDefaults, ProjectSource };

/** Mutable Project declaration the create/update dialogs edit. */
export interface ProjectDraft {
  name: string;
  description?: string;
  source?: ProjectSource;
  locations: ProjectLocation[];
  image_digest?: string;
}

/**
 * The focused Session's Project resolution (#3082).
 *
 * `unbound` is a Session with no membership. `loading` and `unavailable` keep
 * the membership id but do not disclose a partial/unauthorized Project;
 * `ready` carries the authorized Project summary. Capability presence is
 * derived from this, never from cwd/Git/Agent heuristics.
 */
export type FocusedProject =
  | { status: 'unbound' }
  | { status: 'loading'; projectId: string }
  | { status: 'unavailable'; projectId: string }
  | { status: 'ready'; projectId: string; project: Project };

/** What the Project Peek/Workspace needs from app composition (#3082). */
export interface SessionProjectContext {
  focusedProject: FocusedProject;
  relatedSessions: import('@/types').Session[];
  onAssociate: () => void;
  onOpenSession: (session: import('@/types').Session) => void;
  onProjectSettings: (project: Project) => void;
  onCreateProjectSession: (project: Project) => void;
}

/** Everything the shell needs to render and maintain Projects (#3025). */
export interface ProjectShellProps {
  projects: Project[];
  loading: boolean;
  error: string | null;
  selectedProjectId: string | null;
  onCreate: () => void;
  onRetry: () => void;
  onSelect: (project: Project) => void;
  onClose: () => void;
  onRename: (project: Project) => void;
  onSettings: (project: Project) => void;
  onDelete: (project: Project) => void;
  onCreateSession: (project: Project) => void;
}

/**
 * A shell with no Project transport, for component tests that mount one piece
 * of the shell without the Project owner. The shipped shell and every fixture
 * always pass a real one.
 */
export function emptyProjectShell(): ProjectShellProps {
  return {
    projects: [],
    loading: false,
    error: null,
    selectedProjectId: null,
    onCreate: () => undefined,
    onRetry: () => undefined,
    onSelect: () => undefined,
    onClose: () => undefined,
    onRename: () => undefined,
    onSettings: () => undefined,
    onDelete: () => undefined,
    onCreateSession: () => undefined,
  };
}
