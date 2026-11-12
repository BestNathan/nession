import {
  ProjectDeleteDialog,
  ProjectDialogs,
  RenameProjectDialog,
} from '@/product/project/components/ProjectDialogs';
import { AppCreateSessionSurface } from '@/app/experiences/app/AppCreateSessionSurface';
import { AppProjectFormSurface } from '@/app/experiences/app/AppProjectFormSurface';
import type { ExperienceMode } from '@/app/experienceMode';
import type { ProjectDialogState } from '@/product/project/hooks/useProjectDialogs';
import type { Agent } from '@/types';
import type { Project } from '@/product/project/types';

/**
 * The Project operation composition, by Experience (#3089).
 *
 * Web renders the content-capable centered dialogs in `ProjectDialogs`. App
 * renders Project create/settings and Project-aware Session creation as
 * full-height operation depths, while the small rename/delete confirmations
 * keep the shared dialogs. The data owner is one `ProjectDialogState` and one
 * `useProjectDraftForm`; only the composition changes.
 */
export function ProjectShellDialogs({
  experience,
  dialogs,
  agents,
  onChanged,
  onCreated,
  onDeleted,
  onSessionCreated,
}: {
  experience: ExperienceMode;
  dialogs: ProjectDialogState;
  agents: Agent[];
  onChanged: () => Promise<void> | void;
  onCreated: (project: Project) => void;
  onDeleted: (project: Project) => void;
  onSessionCreated: (sessionId?: string) => void;
}) {
  if (experience === 'web') {
    return (
      <ProjectDialogs
        dialogs={dialogs}
        agents={agents}
        onChanged={onChanged}
        onCreated={onCreated}
        onDeleted={onDeleted}
        onSessionCreated={onSessionCreated}
      />
    );
  }

  return (
    <>
      <RenameProjectDialog
        project={dialogs.renameTarget}
        onClose={dialogs.closeRename}
        onChanged={onChanged}
      />
      <ProjectDeleteDialog
        project={dialogs.deleteTarget}
        onClose={dialogs.closeDelete}
        onDeleted={onDeleted}
        onChanged={onChanged}
      />
      <AppProjectFormSurface
        kind="create"
        isOpen={dialogs.createOpen}
        agents={agents}
        onClose={dialogs.closeCreate}
        onChanged={onChanged}
        onSaved={onCreated}
      />
      <AppProjectFormSurface
        kind="settings"
        isOpen={dialogs.settingsTarget !== null}
        project={dialogs.settingsTarget}
        agents={agents}
        onClose={dialogs.closeSettings}
        onChanged={onChanged}
        onSaved={() => undefined}
      />
      <AppCreateSessionSurface
        isOpen={dialogs.sessionProject !== null}
        project={dialogs.sessionProject}
        agents={agents}
        onClose={dialogs.closeCreateSession}
        onCreated={(sessionId) => {
          dialogs.closeCreateSession();
          onSessionCreated(sessionId);
        }}
      />
    </>
  );
}
