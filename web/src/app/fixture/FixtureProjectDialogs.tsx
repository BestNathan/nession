import { ProjectDialogs } from '@/product/project/components/ProjectDialogs';
import type { Agent } from '@/types';
import type { useFixtureProjectShell } from './fixtureProjects';

/** The shipped Project dialogs, wired to a fixture's Project stub. */
export function FixtureProjectDialogs({
  shell,
  agents,
}: {
  shell: ReturnType<typeof useFixtureProjectShell>;
  agents: Agent[];
}) {
  const { dialogs, projects, projectShell } = shell;
  return (
    <ProjectDialogs
      dialogs={dialogs}
      agents={agents}
      onChanged={projects.refresh}
      onCreated={(project) => projectShell.onSelect(project)}
      onDeleted={(project) => {
        if (project.project_id === projectShell.selectedProjectId) {
          projectShell.onClose();
        }
      }}
      onSessionCreated={() => projectShell.onClose()}
    />
  );
}
