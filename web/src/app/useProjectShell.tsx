import { useEffect } from 'react';
import { useProjects } from '@/product/project/hooks/useProjects';
import { useProjectDialogs } from '@/product/project/hooks/useProjectDialogs';
import { ProjectDialogs } from '@/product/project/components/ProjectDialogs';
import type { ProjectShellProps } from '@/product/project/types';
import type { useShellState } from '@/app/useShellState';

/**
 * Project data, destination and dialogs for the shipped shell (#3025).
 *
 * Lives beside `Shell` rather than inside it because the shell's own body is
 * the composition of every destination, and a Project is one of them. The hook
 * owns the one cross-refresh rule: a selected Project that disappeared after a
 * refresh leaves its destination explicitly, instead of showing a stale
 * previous Session.
 */
export function useProjectShell(
  state: ReturnType<typeof useShellState>,
  onSessionCreated: (sessionId?: string) => void,
) {
  const projects = useProjects();
  const dialogs = useProjectDialogs();

  useEffect(() => {
    if (
      projects.loaded &&
      state.selectedProjectId &&
      !projects.projects.some((project) => project.project_id === state.selectedProjectId)
    ) {
      state.handleCloseProject();
    }
  }, [projects.loaded, projects.projects, state]);

  const projectShell: ProjectShellProps = {
    projects: projects.projects,
    loading: projects.loading,
    error: projects.error,
    selectedProjectId: state.selectedProjectId,
    onCreate: dialogs.openCreate,
    onRetry: () => { void projects.refresh(); },
    onSelect: (project) => state.handleSelectProject(project.project_id),
    onClose: state.handleCloseProject,
    onRename: dialogs.openRename,
    onSettings: dialogs.openSettings,
    onDelete: dialogs.openDelete,
    onCreateSession: dialogs.openCreateSession,
  };

  const projectDialogs = (
    <ProjectDialogs
      dialogs={dialogs}
      agents={state.data.agents}
      onChanged={projects.refresh}
      onCreated={(project) => state.handleSelectProject(project.project_id)}
      onDeleted={(project) => {
        if (project.project_id === state.selectedProjectId) {
          state.handleCloseProject();
        }
      }}
      onSessionCreated={onSessionCreated}
    />
  );

  return { projectShell, projectDialogs };
}
