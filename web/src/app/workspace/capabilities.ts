import {
  CapabilityRegistry,
  type CapabilityResolution,
} from '@/features/capabilities';
import { adaptWorkspaceTool, workspaceCapabilityContext } from './capabilityAdapter';
import type { WorkspaceContext, WorkspaceToolId } from './toolTypes';
import { WORKSPACE_TOOLS } from './tools';

const LEGACY_ADAPTER_TOOL_IDS = new Set<WorkspaceToolId>([
  'files',
  'session',
  'agent',
  'env',
]);

/**
 * Transitional registry used while Workspace presentation still consumes the
 * legacy tool registry directly. Claude Code is intentionally excluded so it
 * can become the first direct capability provider in the next migration slice.
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
