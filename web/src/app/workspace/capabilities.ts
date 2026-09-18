import {
  CapabilityRegistry,
  type CapabilityContext,
  type CapabilityDefinition,
  type CapabilityResolution,
  type CapabilityId,
  type CapabilityScope,
} from '@/product/capability';
import {
  CLAUDE_CODE_ID,
  CLAUDE_CODE_TITLE,
  resolveClaudeCodeState,
} from '@/capabilities/claude-code';
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
 * Claude Code's presence is capability knowledge, so it lives with the
 * capability (`resolveClaudeCodeState`) rather than here.
 *
 * What stays in the app layer is only the registration: the id it registers
 * under and the scope it resolves against. Every other provider in this file
 * reads its availability straight off the environment; this one is handed a
 * state derived from observed session facts, which is why it takes a different
 * shape rather than going through `providerFor`.
 */
function claudeCodeProvider(workspaceContext: WorkspaceContext): CapabilityDefinition {
  return {
    id: CLAUDE_CODE_ID,
    title: CLAUDE_CODE_TITLE,
    resolve: (context) => ({
      scope: resolveScope(context, workspaceContext),
      state: resolveClaudeCodeState(context.facts, context.sessionId),
    }),
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
