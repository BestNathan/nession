import {
  CapabilityRegistry,
  type CapabilityContext,
  type CapabilityDefinition,
  type CapabilityResolution,
  type CapabilityScope,
} from '@/features/capabilities';
import {
  adaptWorkspaceTool,
  legacyWorkspaceViewId,
  workspaceCapabilityContext,
} from './capabilityAdapter';
import type { WorkspaceContext, WorkspaceToolId } from './toolTypes';
import { WORKSPACE_TOOLS } from './tools';

const LEGACY_ADAPTER_TOOL_IDS = new Set<WorkspaceToolId>([
  'files',
  'session',
  'agent',
  'env',
]);

function scopeFromContext(context: CapabilityContext): CapabilityScope {
  return {
    workspaceId: context.workspaceId,
    locationId: context.locationId,
    sessionId: context.sessionId,
  };
}

/**
 * First direct Workspace capability provider. Runtime/process detection stays
 * outside this slice, so an attached Session currently means Claude Code is
 * discoverable rather than relevant/active.
 */
const claudeCodeCapability: CapabilityDefinition = {
  id: 'claude-code',
  title: 'Claude Code',
  resolve: (context) => ({
    scope: scopeFromContext(context),
    state: context.sessionId ? 'available' : 'unavailable',
    views: [
      {
        id: legacyWorkspaceViewId('claude-code'),
        label: 'Claude Code',
      },
    ],
  }),
};

/**
 * Transitional registry for the four legacy WorkspaceTool-backed capabilities.
 * Claude Code is intentionally excluded so the migration keeps a real direct
 * provider path alongside the compatibility adapter.
 */
export function createLegacyWorkspaceCapabilityRegistry(
  workspaceContext: WorkspaceContext,
): CapabilityRegistry {
  const registry = new CapabilityRegistry();

  for (const tool of WORKSPACE_TOOLS) {
    if (!LEGACY_ADAPTER_TOOL_IDS.has(tool.id)) {
      continue;
    }
    registry.register(adaptWorkspaceTool(tool, workspaceContext));
  }

  return registry;
}

export function resolveLegacyWorkspaceCapabilities(
  workspaceContext: WorkspaceContext,
): CapabilityResolution {
  return createLegacyWorkspaceCapabilityRegistry(workspaceContext).resolveAll(
    workspaceCapabilityContext(workspaceContext),
  );
}

/**
 * Shipping Workspace capability registry. Presentation consumes this semantic
 * resolution instead of treating the legacy view registry as navigation.
 */
export function createWorkspaceCapabilityRegistry(
  workspaceContext: WorkspaceContext,
): CapabilityRegistry {
  const registry = createLegacyWorkspaceCapabilityRegistry(workspaceContext);
  registry.register(claudeCodeCapability);
  return registry;
}

export function resolveWorkspaceCapabilities(
  workspaceContext: WorkspaceContext,
): CapabilityResolution {
  return createWorkspaceCapabilityRegistry(workspaceContext).resolveAll(
    workspaceCapabilityContext(workspaceContext),
  );
}
