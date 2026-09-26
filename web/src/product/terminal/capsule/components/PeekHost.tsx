import { useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import {
  capsuleIconButtonClass,
  capsuleProjectionClass,
  capsuleProjectionDockClass,
  capsuleProjectionScrollClass,
  capsuleProjectionTextClass,
} from '@/product/terminal/capsule/capsuleStyles';
import type { CapsuleCapabilityProjection } from '@/product/terminal/capsule/types';

/**
 * The surface a capability's Terminal content is drawn on (#1046).
 *
 * This is the **host**, and it owns only what is Nession's: the surface and its
 * bounds, the dismissal, the step from Signal to Peek, and the accessibility
 * baseline. It does not own the path into the Workspace — that was a generic
 * footer here, and it is now an action supplied to the body
 * (`actions.openWorkspace`), because whether a capability has somewhere deeper
 * to go and what that looks like is the capability's answer, not the host's.
 *
 * The name says which half it is. It was `CapabilityProjection`, which read as
 * "the projection of a capability" — the whole thing — while it has only ever
 * been the frame around one.
 *
 * Nothing here touches the resting capsule: this renders *above* it, as a
 * sibling, so the capsule's own geometry is byte-identical whether a projection
 * is present or not (#748, still valid per `capability-emergence.md`).
 *
 * Depth is a parameter, not internal state. Which depth is showing was decided
 * before this mounted (Q1–Q3), so a component that could also change it would
 * be a second, weaker copy of that decision.
 */
export function PeekHost({
  projection,
  sendText,
  disabled,
}: {
  projection: CapsuleCapabilityProjection;
  /** How a capability's body reaches the terminal — the capsule owns this. */
  sendText: (text: string) => void;
  disabled: boolean;
}) {
  const [focus, setFocus] = useState<string | undefined>(undefined);
  const { depth, title, onDeeper, onDismiss, onOpenWorkspace } = projection;
  const isPeek = depth === 'peek';
  const hasDeeper = Boolean(onDeeper);

  return (
    <div
      data-testid="capsule-capability-projection"
      data-capability={projection.id}
      data-depth={projection.depth}
      className={cn(
        capsuleProjectionClass,
        capsuleProjectionDockClass,
        capsuleProjectionTextClass,
        capsuleProjectionScrollClass,
      )}
    >
      <div className="flex items-center justify-between gap-[length:var(--terminal-capsule-projection-item-gap)]">
        <button
          type="button"
          data-testid="capsule-capability-title"
          // At Signal depth the title is the way in; at Peek it is already as
          // deep as the Terminal goes, and a capability with no Peek has
          // nothing behind it to open.
          onClick={isPeek || !hasDeeper ? undefined : () => onDeeper?.()}
          disabled={isPeek || !hasDeeper}
          className={cn(
            'min-w-0 flex-1 truncate text-left font-semibold text-foreground',
            !isPeek &&
              hasDeeper &&
              'rounded transition-colors hover:text-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          {title}
        </button>
        <button
          type="button"
          data-testid="capsule-capability-dismiss"
          aria-label={`Dismiss ${title}`}
          onClick={() => onDismiss()}
          className={cn(
            capsuleIconButtonClass,
            'text-muted-foreground transition-colors hover:text-foreground',
          )}
        >
          <X aria-hidden />
        </button>
      </div>

      {projection.body(focus, setFocus, {
        sendText,
        // Bound here rather than in the hook, because `focus` is this
        // component's state: the deepening a capability offers is *at the item
        // the user picked*, and only the host knows which that was.
        openWorkspace: (resourceId) => onOpenWorkspace?.(resourceId ?? focus),
        disabled,
      })}
    </div>
  );
}
