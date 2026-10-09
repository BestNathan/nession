import type { CapabilityFacts, CapabilityId } from '@/product/capability';
import type { ConversationIdentity } from '@/product/workspace/conversationIdentity';
import { claudeCodeConversation } from '@/capabilities/claude-code';

/**
 * How a capability contributes its conversational identity to the Workspace's
 * Terminal-return circle (#1347 SC-25).
 *
 * The capability owns *what* its conversation is and *when* it is live — the
 * command matcher and the glyph — and the shell only asks the question.
 * `WorkspacePanel` used to answer it by importing `claudeCodeView` and
 * `isClaudeCodeCommand` directly, which made the projection a Claude special
 * case: a second conversational capability (Codex, OpenCode) could not project
 * its identity without editing the shell. Re-review #2 on #1347 rejected
 * exactly that.
 *
 * The same composition rule as `workSignals.ts` applies: the binding type and
 * the registry live here because declaring contributions by value is the
 * surface owner's job (PRINCIPLE #5); the capability imports this type
 * type-only and exports its binding from its own `contribution.tsx`. A second
 * conversational capability arrives by writing its `sense` and adding one line
 * to the list — nothing in the resolver can name it.
 *
 * `sense` is a **pure function of observed facts**, reading the same
 * `CapabilityFacts` the capsule's work awareness reads, so the ring and the
 * destination glyph can never disagree about the same pane.
 */
export interface CapabilityConversationBinding {
  id: CapabilityId;
  /**
   * Return this capability's identity while its conversation is live in the
   * observed session, or `null` when it is not. Absence is the quiet answer —
   * a binding must not project an identity for a session it is idle in.
   */
  sense: (facts: CapabilityFacts | undefined) => ConversationIdentity | null;
}

/**
 * Conversational capabilities, in registration order.
 */
const CONVERSATION_BINDINGS: readonly CapabilityConversationBinding[] = [
  claudeCodeConversation,
];

/**
 * Resolve the one live conversational identity from one observation.
 *
 * At most one conversation can own the pane's foreground at a time, so the
 * first live identity wins. The `bindings` parameter exists so a test can
 * prove the seam is generic — a binding the resolver has never seen flows
 * through by shape, not by name. Production never passes it.
 */
export function resolveConversationIdentity(
  facts: CapabilityFacts | undefined,
  bindings: readonly CapabilityConversationBinding[] = CONVERSATION_BINDINGS,
): ConversationIdentity | null {
  for (const binding of bindings) {
    const identity = binding.sense(facts);
    if (identity) {
      return identity;
    }
  }
  return null;
}
