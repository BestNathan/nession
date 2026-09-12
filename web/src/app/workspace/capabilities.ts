import {
  CapabilityRegistry,
  type CapabilityContext,
  type CapabilityDefinition,
  type CapabilityResolution,
  type CapabilityScope,
  type CapabilityState,
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
 * Commands that mean "Claude Code is running here".
 *
 * Deliberately excludes `node`: `claude` surfaces as `node` on some installs,
 * but so does every other node TUI, and a false positive would light Claude
 * Code up for unrelated work. Under-matching is the honest failure here.
 */
const CLAUDE_CODE_COMMANDS = ['claude'];

function isClaudeCodeCommand(command: string): boolean {
  return CLAUDE_CODE_COMMANDS.includes(command);
}

/**
 * First direct Workspace capability provider.
 *
 * Runtime detection belongs to the surface that owns the signal: the agent
 * reports the session's foreground command, the app layer records what it has
 * seen, and this provider turns those facts into state.
 */
const claudeCodeCapability: CapabilityDefinition = {
  id: 'claude-code',
  title: 'Claude Code',
  resolve: (context) => {
    const current = context.facts?.sessionForegroundCommand;
    const observed = context.facts?.sessionObservedCommands ?? [];

    let state: CapabilityState;
    if (!context.sessionId) {
      state = 'unavailable';
    } else if (current && isClaudeCodeCommand(current)) {
      state = 'active';
    } else if (observed.some(isClaudeCodeCommand)) {
      state = 'relevant';
    } else {
      state = 'available';
    }

    return {
      scope: scopeFromContext(context),
      state,
      views: [
        {
          id: legacyWorkspaceViewId('claude-code'),
          label: 'Claude Code',
        },
      ],
    };
  },
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
