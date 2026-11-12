import { createElement } from 'react';
import { FolderKanban } from 'lucide-react';
import type { CapsuleProjectionBinding } from '@/app/capsuleProjections';
import { PROJECT_CAPABILITY_ID } from './model';
import { ProjectPeek } from './components/ProjectPeek';

export { PROJECT_CAPABILITY_ID, PROJECT_CAPABILITY_TITLE } from './model';

/** Terminal Peek for the focused Session's explicit Project. */
export const projectProjection: CapsuleProjectionBinding = {
  id: PROJECT_CAPABILITY_ID,
  icon: FolderKanban,
  body: (props) =>
    createElement(ProjectPeek, {
      context: props.projectContext,
      state: props.state,
    }),
};
