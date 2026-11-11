import { ImagesPlugin } from './ImagesPlugin';
import { ProjectsPlugin } from './ProjectsPlugin';

/** Module singleton bound by `useAppConnection` and every fixture route. */
export const projectsApi = new ProjectsPlugin();
/** Global EROFS Image Manager transport (#3022). */
export const imagesApi = new ImagesPlugin();

export type {
  Project,
  ProjectDraft,
  ProjectLocation,
  ProjectSessionDefaults,
  ProjectShellProps,
  ProjectSource,
} from './types';
