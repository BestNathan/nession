import type { LucideIcon } from 'lucide-react';
import type { CapabilityId } from '@/product/capability';

/**
 * What a live conversational capability projects into the Workspace's
 * Terminal-return circle (#1347 SC-25): "your conversation is over there".
 *
 * The requirement's contract is *replace inner glyph* — while the conversation
 * is live, the capability's icon is drawn **in place of** the destination
 * action's own Terminal icon, not beside it as a badge. The destination itself
 * is untouched (SC-26): `SurfaceDestinationAction` keeps its aria-label,
 * activation and geometry no matter what is projected, so an identity can only
 * ever re-skin the icon, never retarget the action.
 *
 * Only the identity lives here in the product layer; *which* capabilities are
 * conversational and *when* one is live is contribution knowledge, declared by
 * the capability and collected in `app/conversationIdentities.ts`.
 */
export interface ConversationIdentity {
  capabilityId: CapabilityId;
  /**
   * The capability's glyph, rendered in place of the destination icon while
   * the conversation is live. Same `LucideIcon` chrome vocabulary the
   * Workspace view bindings use, so a projected identity sits at the same
   * size and weight as the icon it replaces.
   */
  glyph: LucideIcon;
}
