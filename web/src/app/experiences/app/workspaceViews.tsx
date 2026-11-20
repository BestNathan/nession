import type { ComponentType } from 'react';
import { AgentDetail } from '@/product/agent/patterns/AgentDetail';
import { SessionDetails } from '@/product/session/components/SessionDetails';
import { EnvAppLayout } from './EnvAppLayout';
import { FilesAppLayout } from './FilesAppLayout';
import { SandboxAppLayout } from './SandboxAppLayout';
import type { WorkspaceAppViewProps, WorkspaceViewId } from '@/app/workspace/workspaceContext';

/**
 * How the App experience draws each Workspace capability.
 *
 * This file is where the Web/App difference for these views actually lives.
 * The Web half renders the same contents bare; the App half contributes
 * content only (#4115). The *App host* owns the page scrollport and the
 * Capsule clearance (`AppWorkspaceScrollRegion` in `WorkspaceShell`), so the
 * Agent and Session details are no longer wrapped in scroll chrome here: a
 * capability that adds ordinary block/section/row content gets correct
 * end-of-scroll geometry without opting in.
 *
 * Every entry is handed the shell's `depth` control (#1051), whether or not it
 * pushes today: the App's navigation bar belongs to whichever depth the view is
 * at, so a view that grows an internal push declares it here rather than
 * rendering a bar of its own.
 *
 * The ready-check is written out again rather than reused from the Web map: the
 * wrapper must not exist when the content does not. `WorkspaceScrollRegion`
 * cannot tell an absent child from an empty one, so the decision has to be made
 * before it is rendered, and "what to draw when the context is not ready" is
 * each experience's own call.
 *
 * `FilesAppLayout` and `EnvAppLayout` are the two entries that are more than
 * chrome — push-navigation compositions (list → detail/editor, with the leave
 * guard living in the capability's depth policy) rather than a grid. That,
 * too, is an experience difference, and it is why the App owns this file rather
 * than the capability.
 */
export const APP_WORKSPACE_VIEWS: Record<WorkspaceViewId, ComponentType<WorkspaceAppViewProps>> = {
  agent: ({ ctx }) =>
    ctx.agent && ctx.domain ? (
      <div data-testid="agent-detail-app">
        <AgentDetail
          agent={ctx.agent}
          state={ctx.domain}
          currentSessionId={
            ctx.session?.agent_id === ctx.agent.agent_id ? ctx.session.session_id : null
          }
        />
      </div>
    ) : null,
  session: ({ ctx }) =>
    ctx.session && ctx.domain ? (
      <div data-testid="session-details-app">
        <SessionDetails session={ctx.session} state={ctx.domain} />
      </div>
    ) : null,
  env: EnvAppLayout,
  files: FilesAppLayout,
  sandbox: SandboxAppLayout,
};
