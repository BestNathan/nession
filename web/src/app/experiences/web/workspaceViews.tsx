import type { ComponentType } from 'react';
import { AgentDetail } from '@/product/agent/patterns/AgentDetail';
import { SessionDetails } from '@/product/session/components/SessionDetails';
import { FilesWebLayout } from './FilesWebLayout';
import { EnvWebLayout } from './EnvWebLayout';
import type { WorkspaceContext, WorkspaceViewId } from '@/app/workspace/workspaceContext';

/**
 * How the Web experience draws each Workspace capability.
 *
 * Nothing here wears chrome. The Web workspace is a pane that the view fills, so
 * every entry is the capability's own content and no more — which is why the
 * Web/App difference for these four views lives entirely in the App half of the
 * pair (`experiences/app/workspaceViews.tsx`), not in a flag on a shared
 * component. `FilesWebLayout` and `EnvWebLayout` are the substantial entries:
 * navigator ‖ detail grids, which are compositions but still no chrome of their
 * own.
 *
 * The ready-check (`ctx.agent && ctx.domain`) is repeated in the App map rather
 * than shared. It reads like duplication and is not: what to draw when the
 * context is not ready is an experience's own decision — both answer "nothing"
 * today, but the App has to answer it *before* its scroll wrapper exists, or an
 * empty scroller would render where the view should be absent.
 */
export const WEB_WORKSPACE_VIEWS: Record<WorkspaceViewId, ComponentType<{ ctx: WorkspaceContext }>> = {
  agent: ({ ctx }) =>
    ctx.agent && ctx.domain ? <AgentDetail agent={ctx.agent} state={ctx.domain} /> : null,
  session: ({ ctx }) =>
    ctx.session && ctx.domain ? <SessionDetails session={ctx.session} state={ctx.domain} /> : null,
  env: EnvWebLayout,
  files: FilesWebLayout,
};
