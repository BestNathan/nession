import {
  CapabilityRegistry,
  type CapabilityContext,
  type CapabilityDefinition,
  type CapabilityResolution,
  type CapabilityId,
  type CapabilityScope,
  type CapabilityState,
} from '@/product/capability';
import type { WorkspaceContext } from './workspaceContext';

export function workspaceCapabilityContext(ctx: WorkspaceContext): CapabilityContext {
  return {
    sessionId: ctx.session?.session_id,
    locationId: ctx.agent?.agent_id ?? ctx.session?.agent_id,
    surface: 'workspace',
    facts: ctx.facts,
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
 * The Workspace's own capabilities.
 *
 * Each one states what it is and when it is available; none of them states where
 * it appears. Direct chrome, disclosure and absence are decided downstream by the
 * presence policy and the presentation model, so a capability cannot buy itself a
 * slot by being registered.
 */
interface WorkspaceCapabilityProvider {
  id: CapabilityId;
  title: string;
  /** Whether the environment can offer this capability at all. */
  available: (ctx: WorkspaceContext) => boolean;
}

/**
 * In registration order. The order is a deterministic tie-break between equally
 * present capabilities — it is not priority, and it grants nothing.
 */
const WORKSPACE_CAPABILITY_PROVIDERS: readonly WorkspaceCapabilityProvider[] = [
  { id: 'files', title: 'Files', available: (ctx) => ctx.fileOps !== null },
  { id: 'session', title: 'Session', available: () => true },
  { id: 'agent', title: 'Agent', available: () => true },
  { id: 'env', title: 'Env', available: () => true },
];

const CLAUDE_CODE_PROVIDER: WorkspaceCapabilityProvider = {
  id: 'claude-code',
  title: 'Claude Code',
  available: () => true,
};

function providerFor(
  provider: WorkspaceCapabilityProvider,
  workspaceContext: WorkspaceContext,
): CapabilityDefinition {
  return {
    id: provider.id,
    title: provider.title,
    resolve: (context) => ({
      scope: resolveScope(context, workspaceContext),
      state: provider.available(workspaceContext) ? 'available' : 'unavailable',
    }),
  };
}

/**
 * Commands that mean "Claude Code is running here".
 *
 * `claude.exe` is the name the CLI actually runs under: the distributed package
 * installs its native binary as `bin/claude.exe`, and that is what the agent
 * reports as the pane's foreground command (measured against a real install).
 * The bare name covers installs that expose a plain `claude` wrapper.
 *
 * Deliberately excludes `node`: `claude` surfaces as `node` on some installs,
 * but so does every other node TUI, and a false positive would light Claude
 * Code up for unrelated work. Under-matching is the honest failure here.
 */
const CLAUDE_CODE_COMMANDS = ['claude', 'claude.exe'];

function isClaudeCodeCommand(command: string): boolean {
  return CLAUDE_CODE_COMMANDS.includes(command);
}

/**
 * The one provider whose state comes from observation rather than environment:
 * the agent reports the session's foreground command, the app layer records what
 * it has seen, and this turns those facts into a state.
 */
function claudeCodeProvider(workspaceContext: WorkspaceContext): CapabilityDefinition {
  return {
    id: CLAUDE_CODE_PROVIDER.id,
    title: CLAUDE_CODE_PROVIDER.title,
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

      return { scope: resolveScope(context, workspaceContext), state };
    },
  };
}

/**
 * Shipping Workspace capability registry: every capability the Workspace can
 * show, registered once, none of them through a compatibility path.
 */
export function createWorkspaceCapabilityRegistry(
  workspaceContext: WorkspaceContext,
): CapabilityRegistry {
  const registry = new CapabilityRegistry();

  for (const provider of WORKSPACE_CAPABILITY_PROVIDERS) {
    registry.register(providerFor(provider, workspaceContext));
  }
  registry.register(claudeCodeProvider(workspaceContext));

  return registry;
}

export function resolveWorkspaceCapabilities(
  workspaceContext: WorkspaceContext,
): CapabilityResolution {
  return createWorkspaceCapabilityRegistry(workspaceContext).resolveAll(
    workspaceCapabilityContext(workspaceContext),
  );
}
