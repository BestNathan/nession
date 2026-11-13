import type { ComponentType } from 'react';
import { AgentDetail } from '@/product/agent/patterns/AgentDetail';
import { SessionDetails } from '@/product/session/components/SessionDetails';
import { WorkspaceScrollRegion } from '@/app/workspace/layout/workspaceLayout';
import { FilesWebLayout } from './FilesWebLayout';
import { EnvWebLayout } from './EnvWebLayout';
import { SandboxWebLayout } from '@/capabilities/sandbox';
import type { WorkspaceContext, WorkspaceViewId } from '@/app/workspace/workspaceContext';

/**
 * How the Web experience draws each Workspace capability.
 *
 * Nothing here wears navigation chrome. The Web workspace is a pane that the
 * view fills; detail views take their single scroll owner from the shared
 * `WorkspaceScrollRegion` recipe (#3194) rather than owning idle scroll
 * ancestry themselves, and Files/Environment use the shared master/detail
 * recipe. The Web/App difference for these four views still lives in the App
 * half of the pair (`experiences/app/workspaceViews.tsx`), not in a flag on a
 * shared component.
 *
 * The ready-check is repeated in the App map rather than shared. It reads like
 * duplication and is not: what to draw when the context is not ready is an
 * experience's own decision — both answer "nothing" today, but the App has to
 * answer it *before* its scroll wrapper exists, or an empty scroller would
 * render where the view should be absent.
 */
export const WEB_WORKSPACE_VIEWS: Record<WorkspaceViewId, ComponentType<{ ctx: WorkspaceContext }>> = {
  agent: ({ ctx }) =>
    ctx.agent && ctx.domain ? (
      <WorkspaceScrollRegion data-testid="agent-detail-web">
        <AgentDetail
          agent={ctx.agent}
          state={ctx.domain}
          currentSessionId={
            ctx.session?.agent_id === ctx.agent.agent_id ? ctx.session.session_id : null
          }
        />
      </WorkspaceScrollRegion>
    ) : null,
  session: ({ ctx }) =>
    ctx.session && ctx.domain ? (
      <WorkspaceScrollRegion data-testid="session-details-web">
        <SessionDetails session={ctx.session} state={ctx.domain} />
      </WorkspaceScrollRegion>
    ) : null,
  env: EnvWebLayout,
  files: FilesWebLayout,
  sandbox: SandboxWebLayout,
};
