import { ProjectsPlugin } from './ProjectsPlugin';

/** Module singleton bound by `useAppConnection` and every fixture route. */
export const projectsApi = new ProjectsPlugin();
export type {
  Project,
  ProjectDraft,
  ProjectLocation,
  ProjectSessionDefaults,
  ProjectShellProps,
  ProjectSource,
} from './types';
