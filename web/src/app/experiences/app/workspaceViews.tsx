import type { ComponentType } from 'react';
import { EnvManager } from '@/capabilities/env';
import { AgentDetail } from '@/product/agent/patterns/AgentDetail';
import { SessionDetails } from '@/product/session/components/SessionDetails';
import { AppToolScroll } from './AppToolScroll';
import { FilesAppLayout } from './FilesAppLayout';
import type { WorkspaceContext, WorkspaceViewId } from '@/app/workspace/workspaceContext';

/**
 * How the App experience draws each Workspace capability.
 *
 * This file is where the Web/App difference for these views actually lives. The
 * Web half renders the same three contents bare; the App half puts each one
 * inside its own scroll chrome, because the App workspace floats a tool bar over
 * the bottom of the pane and the view has to clear it. Expressing that here —
 * once, as composition — is what keeps it from becoming a flag threaded through
 * shared components.
 *
 * The ready-check is written out again rather than reused from the Web map: the
 * wrapper must not exist when the content does not. `AppToolScroll` cannot tell
 * an absent child from an empty one, so the decision has to be made before it is
 * rendered, and "what to draw when the context is not ready" is each
 * experience's own call.
 *
 * `FilesAppLayout` is the one entry that is more than chrome — a push-navigation
 * composition (tree → editor with its own back affordance and discard confirm)
 * rather than a grid. That, too, is an experience difference, and it is why the
 * App owns this file rather than the capability.
 */
export const APP_WORKSPACE_VIEWS: Record<WorkspaceViewId, ComponentType<{ ctx: WorkspaceContext }>> = {
  agent: ({ ctx }) =>
    ctx.agent && ctx.domain ? (
      <AppToolScroll data-testid="agent-detail-app">
        <AgentDetail agent={ctx.agent} state={ctx.domain} />
      </AppToolScroll>
    ) : null,
  session: ({ ctx }) =>
    ctx.session && ctx.domain ? (
      <AppToolScroll data-testid="session-details-app">
        <SessionDetails session={ctx.session} state={ctx.domain} />
      </AppToolScroll>
    ) : null,
  env: ({ ctx }) => (
    <AppToolScroll data-testid="env-workspace-app">
      <EnvManager agents={ctx.agents} embedded />
    </AppToolScroll>
  ),
  files: FilesAppLayout,
};
