import type { FocusedProject, Project } from '@/product/project/types';
import type { Session } from '@/types';

/**
 * Resolve the focused Session's explicit Project membership (#3082).
 *
 * The membership id comes from the Server-owned Session read model. The
 * summary is looked up from the Project list; an unknown id while the list is
 * still loading is `loading`, otherwise it is `unavailable`. Never infer a
 * Project from cwd, Git, Agent identity or a globally selected Project.
 */
export function resolveFocusedProject(
  session: Session | null,
  projects: readonly Project[],
  loading: boolean,
): FocusedProject {
  const projectId = session?.project_id;
  if (!projectId) {
    return { status: 'unbound' };
  }
  const project = projects.find((candidate) => candidate.project_id === projectId);
  if (project) {
    return { status: 'ready', projectId, project };
  }
  return { status: loading ? 'loading' : 'unavailable', projectId };
}

/** Sessions that share the focused Session's Project; empty when unbound. */
export function relatedSessionsFor(
  session: Session | null,
  sessions: readonly Session[],
): Session[] {
  const projectId = session?.project_id;
  if (!projectId) {
    return [];
  }
  return sessions.filter(
    (candidate) => candidate.project_id === projectId && candidate.session_id !== session.session_id,
  );
}
