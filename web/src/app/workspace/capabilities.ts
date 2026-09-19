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
import { GIT_ID, GIT_TITLE, resolveGitState } from '@/capabilities/git';
import {
  TERMINAL_KEYS_ID,
  TERMINAL_KEYS_TITLE,
  resolveTerminalKeysState,
} from '@/product/terminal/terminalKeys';
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
 * Git's presence is likewise capability knowledge (`resolveGitState`), and
 * likewise only registration happens here. It resolves against the Session and
 * nothing else: whether that Session sits in a repository is an answer only the
 * agent can give, so presence does not pretend to know it (#750 SC4).
 */
function gitProvider(workspaceContext: WorkspaceContext): CapabilityDefinition {
  return {
    id: GIT_ID,
    title: GIT_TITLE,
    resolve: (context) => ({
      scope: resolveScope(context, workspaceContext),
      state: resolveGitState(context.sessionId),
    }),
  };
}

/**
 * Terminal Keys is a capability of the Terminal and nothing else (`#826` §7).
 *
 * It is registered here because this is the app's one capability registry —
 * both surfaces read it, and the `Workspace` in the name is now narrower than
 * what it holds. It appears in the capsule's `+` and nowhere in the Workspace,
 * which falls out of the machinery rather than needing a rule: the Workspace
 * filters its chrome to capabilities that have a `WorkspaceViewBinding`, and
 * this one deliberately has none.
 */
function terminalKeysProvider(workspaceContext: WorkspaceContext): CapabilityDefinition {
  return {
    id: TERMINAL_KEYS_ID,
    title: TERMINAL_KEYS_TITLE,
    resolve: (context) => ({
      scope: resolveScope(context, workspaceContext),
      state: resolveTerminalKeysState(context.sessionId),
    }),
  };
}

/**
 * Shipping capability registry: every capability the app can show, registered
 * once, none of them through a compatibility path.
 */
export function createWorkspaceCapabilityRegistry(
  workspaceContext: WorkspaceContext,
): CapabilityRegistry {
  const registry = new CapabilityRegistry();

  for (const provider of WORKSPACE_CAPABILITY_PROVIDERS) {
    registry.register(providerFor(provider, workspaceContext));
  }
  registry.register(claudeCodeProvider(workspaceContext));
  registry.register(gitProvider(workspaceContext));
  registry.register(terminalKeysProvider(workspaceContext));

  return registry;
}

export function resolveWorkspaceCapabilities(
  workspaceContext: WorkspaceContext,
): CapabilityResolution {
  return createWorkspaceCapabilityRegistry(workspaceContext).resolveAll(
    workspaceCapabilityContext(workspaceContext),
  );
}
