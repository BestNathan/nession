import { ProjectDialogs } from '@/product/project/components/ProjectDialogs';
import { ProjectShellDialogs } from '@/app/ProjectShellDialogs';
import type { ExperienceMode } from '@/app/experienceMode';
import type { Agent } from '@/types';
import type { useFixtureProjectShell } from './fixtureProjects';

/** The shipped Project operation composition, wired to a fixture's stub. */
export function FixtureProjectDialogs({
  shell,
  agents,
  experience = 'web',
}: {
  shell: ReturnType<typeof useFixtureProjectShell>;
  agents: Agent[];
  experience?: ExperienceMode;
}) {
  const { dialogs, projects, projectShell } = shell;
  const common = {
    dialogs,
    agents,
    onChanged: projects.refresh,
    onCreated: (project: Parameters<typeof projectShell.onSelect>[0]) =>
      projectShell.onSelect(project),
    onDeleted: (project: Parameters<typeof projectShell.onSelect>[0]) => {
      if (project.project_id === projectShell.selectedProjectId) {
        projectShell.onClose();
      }
    },
    onSessionCreated: () => projectShell.onClose(),
  };
  return experience === 'app' ? (
    <ProjectShellDialogs experience="app" {...common} />
  ) : (
    <ProjectDialogs {...common} />
  );
}
