import { AppProjectDetail } from '@/app/patterns/AppProjectDetail';
import type { ProjectShellProps } from '@/product/project/types';
import type { Agent } from '@/types';

/** The App Project detail destination for the App fixture route (#3025). */
export function FixtureAppProjectDetail({
  shell,
  agents,
}: {
  shell: ProjectShellProps;
  agents: Agent[];
}) {
  const project =
    shell.projects.find((candidate) => candidate.project_id === shell.selectedProjectId) ?? null;
  if (!project) {
    return null;
  }
  return (
    <AppProjectDetail
      project={project}
      agents={agents}
      onCreateSession={shell.onCreateSession}
      onSettings={shell.onSettings}
      onBack={shell.onClose}
    />
  );
}
