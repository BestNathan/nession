import type { ComponentType } from 'react';
import { AgentDetail } from '@/product/agent/patterns/AgentDetail';
import { SessionDetails } from '@/product/session/components/SessionDetails';
import { AppToolScroll } from './AppToolScroll';
import { EnvAppLayout } from './EnvAppLayout';
import { FilesAppLayout } from './FilesAppLayout';
import type { WorkspaceAppViewProps, WorkspaceViewId } from '@/app/workspace/workspaceContext';

/**
 * How the App experience draws each Workspace capability.
 *
 * This file is where the Web/App difference for these views actually lives. The
 * Web half renders the same contents bare; the App half wraps the two detail
 * views in their own scroll chrome, because the App workspace floats a
 * capability dock over the bottom of the pane and the view has to clear it.
 * Expressing that here — once, as composition — is what keeps it from becoming
 * a flag threaded through shared components.
 *
 * Every entry is handed the shell's `depth` control (#1051), whether or not it
 * pushes today: the App's navigation bar belongs to whichever depth the view is
 * at, so a view that grows an internal push declares it here rather than
 * rendering a bar of its own. The two scroll-chrome views never push, and say
 * so by never calling it.
 *
 * The ready-check is written out again rather than reused from the Web map: the
 * wrapper must not exist when the content does not. `AppToolScroll` cannot tell
 * an absent child from an empty one, so the decision has to be made before it is
 * rendered, and "what to draw when the context is not ready" is each
 * experience's own call.
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
  env: EnvAppLayout,
  files: FilesAppLayout,
};
