import type { ComponentType } from 'react';
import { EnvManager } from '@/capabilities/env';
import { AgentDetail } from '@/product/agent/patterns/AgentDetail';
import { SessionDetails } from '@/product/session/components/SessionDetails';
import { AppToolScroll } from './AppToolScroll';
import { FilesAppLayout } from './FilesAppLayout';
import type { WorkspaceAppViewProps, WorkspaceViewId } from '@/app/workspace/workspaceContext';

/**
 * How the App experience draws each Workspace capability.
 *
 * This file is where the Web/App difference for these views actually lives. The
 * Web half renders the same three contents bare; the App half puts each one
 * inside its own scroll chrome, because the App workspace floats a capability
 * dock over the bottom of the pane and the view has to clear it. Expressing that
 * here — once, as composition — is what keeps it from becoming a flag threaded
 * through shared components.
 *
 * Every entry is handed the shell's `depth` control (#1051), whether or not it
 * pushes today: the App's navigation bar belongs to whichever depth the view is
 * at, so a view that grows an internal push declares it here rather than
 * rendering a bar of its own. The three grid views never push, and say so by
 * never calling it.
 *
 * The ready-check is written out again rather than reused from the Web map: the
 * wrapper must not exist when the content does not. `AppToolScroll` cannot tell
 * an absent child from an empty one, so the decision has to be made before it is
 * rendered, and "what to draw when the context is not ready" is each
 * experience's own call.
 *
 * `FilesAppLayout` is the one entry that is more than chrome — a push-navigation
 * composition (list → editor with a discard confirm) rather than a grid. That,
 * too, is an experience difference, and it is why the App owns this file rather
 * than the capability.
 */
export const APP_WORKSPACE_VIEWS: Record<WorkspaceViewId, ComponentType<WorkspaceAppViewProps>> = {
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
