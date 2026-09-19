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
 * A capability emerging next to the capsule, at the depth Nession chose.
 *
 * This is the frame, and the frame is Nession's: the surface, the title, how to
 * dismiss, how to go one level deeper, and the path into Workspace. The
 * capability supplies only the body. That split is the point — a capability
 * that drew its own frame would be choosing its own placement, which
 * `workspace-navigation.md` puts on Nession's side of the line.
 *
 * Nothing here touches the resting capsule: this renders *above* it, as a
 * sibling, so the capsule's own geometry is byte-identical whether a projection
 * is present or not (#748, still valid per `capability-emergence.md`).
 *
 * Depth is a parameter, not internal state. Which depth is showing was decided
 * before this mounted (Q1–Q3), so a component that could also change it would
 * be a second, weaker copy of that decision.
 */
export function CapabilityProjection({
  projection,
}: {
  projection: CapsuleCapabilityProjection;
}) {
  const [focus, setFocus] = useState<string | undefined>(undefined);
  const { depth, title, onDeeper, onDismiss, onOpenWorkspace } = projection;
  const isPeek = depth === 'peek';

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
          // At Signal depth the whole title is the way in; at Peek it is already
          // as deep as the Terminal goes.
          onClick={isPeek ? undefined : () => onDeeper()}
          disabled={isPeek}
          className={cn(
            'min-w-0 flex-1 truncate text-left font-semibold text-foreground',
            !isPeek &&
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

      {projection.body(focus, setFocus)}

      {isPeek && onOpenWorkspace ? (
        <div className="flex justify-end">
          <button
            type="button"
            data-testid="capsule-capability-open-workspace"
            onClick={() => onOpenWorkspace(focus)}
            className="rounded px-[length:var(--terminal-capsule-projection-item-pad-x)] font-medium text-foreground transition-colors hover:text-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Open in Workspace →
          </button>
        </div>
      ) : null}
    </div>
  );
}
