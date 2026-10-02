import { useState } from 'react';
import { X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/shared/lib/utils';
import {
  capsuleIconButtonClass,
  capsuleProjectionClass,
  capsuleProjectionDockClass,
  capsuleProjectionScrollClass,
  capsuleProjectionTextClass,
} from '@/product/terminal/capsule/capsuleStyles';
import type {
  CapsuleCapabilityProjection,
  CapsuleDetail,
} from '@/product/terminal/capsule/types';

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
  sendPhysKey,
  disabled,
}: {
  projection: CapsuleCapabilityProjection;
  /** How a capability's body reaches the terminal — the capsule owns this. */
  sendText: (text: string) => void;
  sendPhysKey?: (key: {
    seq?: string;
    semanticKey?: import('@/platform/terminal-runtime/interaction/TerminalInteractionController').TerminalSemanticKey;
  }) => void;
  disabled: boolean;
}) {
  const [focus, setFocus] = useState<string | undefined>(undefined);
  // The approved child overlay (#1120). Held here rather than by the capability
  // so that placement, dismissal and the accessible name stay the host's — a
  // capability supplies content and nothing else, exactly as it does for the
  // body itself.
  const [detail, setDetail] = useState<CapsuleDetail | null>(null);
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
        // The containment boundary (#1347 SC-27): paint containment clips the
        // body to this box and makes it the containing block and stacking
        // context for everything inside — a plugin body's `position: fixed`
        // resolves against the host instead of the viewport, and its z-index
        // cannot leapfrog the shell's own layers. Combined with the binding
        // contract's no-portals rule (#1120), that is "cannot escape the Peek
        // host" enforced rather than intended. The host's own overlay is
        // unaffected: the Dialog portals to the body, outside this subtree.
        'contain-paint',
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
        sendPhysKey,
        // Bound here rather than in the hook, because `focus` is this
        // component's state: the deepening a capability offers is *at the item
        // the user picked*, and only the host knows which that was.
        openWorkspace: (resourceId) => onOpenWorkspace?.(resourceId ?? focus),
        openDetail: setDetail,
        disabled,
      })}

      {/*
        The child overlay, drawn by base-ui's Dialog so that focus trapping,
        Escape, the scroll lock and returning focus to whatever opened it are
        the primitive's job rather than this file's — the reason `#1120` asks
        for an approved primitive instead of each capability portalling for
        itself.

        Rendered as a sibling of the Peek rather than nested inside it: the
        Peek keeps its geometry, and the Dialog portals to the body, so the
        overlay never inherits the capsule's stacking or overflow.
      */}
      <Dialog
        open={detail !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDetail(null);
          }
        }}
      >
        {/* No sizing of its own. `DialogContent` already bounds itself to the
            viewport and scrolls, and a height here would be a metric invented
            in the capsule — which the design gate refuses, and rightly: the
            overlay's proportions belong to the visual pass (#1120 OQ1), not to
            the first caller that needed one.

            The content still scrolls itself rather than the Terminal: the
            dialog is portalled and bounded, so nothing behind it moves. */}
        <DialogContent
          data-testid="capsule-capability-detail"
          className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-lg"
        >
          <DialogHeader>
            <DialogTitle>{detail?.title ?? ''}</DialogTitle>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col">{detail?.content}</div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
