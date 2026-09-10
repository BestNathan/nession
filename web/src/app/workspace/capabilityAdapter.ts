import type {
  CapabilityContext,
  CapabilityDefinition,
  CapabilityScope,
} from '@/features/capabilities';
import type { WorkspaceContext, WorkspaceTool } from './toolTypes';

export function legacyWorkspaceViewId(toolId: string): string {
  return `workspace-tool:${toolId}`;
}

export function workspaceCapabilityContext(ctx: WorkspaceContext): CapabilityContext {
  return {
    sessionId: ctx.session?.session_id,
    locationId: ctx.agent?.agent_id ?? ctx.session?.agent_id,
    surface: 'workspace',
  };
}

function resolveScope(
  context: CapabilityContext,
  workspaceContext: WorkspaceContext,
): CapabilityScope {
  return {
    workspaceId: context.workspaceId,
    locationId:
      context.locationId ?? workspaceContext.agent?.agent_id ?? workspaceContext.session?.agent_id,
    sessionId: context.sessionId ?? workspaceContext.session?.session_id,
  };
}

/**
 * Migration adapter for the legacy WorkspaceTool registry.
 *
 * It deliberately carries only semantic capability state and a stable view
 * descriptor into the shared capability layer. Legacy order, icon, and shell
 * placement remain outside the capability core and will be retired by the
 * Workspace presentation migration.
 */
export function adaptWorkspaceTool(
  tool: WorkspaceTool,
  workspaceContext: WorkspaceContext,
): CapabilityDefinition {
  return {
    id: tool.id,
    title: tool.label,
    resolve: (context) => ({
      scope: resolveScope(context, workspaceContext),
      state: tool.availability(workspaceContext) ? 'available' : 'unavailable',
      views: [
        {
          id: legacyWorkspaceViewId(tool.id),
          label: tool.label,
        },
      ],
    }),
  };
}
