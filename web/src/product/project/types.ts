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
