import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { capsulePeekActionClass } from '@/shared/lib/peekActionClass';
import { CapsuleIconVisual } from '@/product/terminal/capsule/CapsuleIconVisual';
import {
  capsuleDetailDialogClass,
  capsuleProjectionClass,
  capsuleProjectionDockClass,
  capsuleProjectionScrollClass,
  capsuleUpperCloseButtonClass,
  capsuleUpperHeaderClass,
  capsuleUpperSwitchClass,
  capsuleUpperSwitchOptionClass,
  capsuleUpperTitleClass,
} from '@/product/terminal/capsule/capsuleStyles';
import type {
  CapsuleCapabilityProjection,
  CapsuleCapabilityViewSwitch,
  CapsuleDetail,
} from '@/product/terminal/capsule/types';

/**
 * The surface a capability's Terminal content is drawn on (#1046).
 *
 * This is the **host**, and it owns only what is Nession's: the surface and its
 * bounds, the dismissal, the accessibility baseline — and the Workspace
 * destination. `#1347` SC-21 is explicit: "Peek header and Workspace
 * destination are Nession-owned", and re-review #2 on it settled that `#1046`'s
 * body-owns-the-action model is superseded on this point. Whether the
 * destination exists is the app layer's answer (the Workspace view registry),
 * and its presentation — one action, here — is drawn by this host. What stays
 * with the body is *content*
 * navigation: a row that opens the item it names
 * (`actions.openWorkspace(resourceId)`), which is the body's scrollable
 * content using the host's routing, not a second destination action.
 *
 * The name says which half it is. It was `CapabilityProjection`, which read as
 * "the projection of a capability" — the whole thing — while it has only ever
 * been the frame around one.
 *
 * Nothing here touches the resting capsule: this renders *above* it, as a
 * sibling, so the capsule's own geometry is byte-identical whether a projection
 * is present or not (#748, still valid per `capability-emergence.md`).
 */
export function PeekHost({
  projection,
  sendText,
  sendPhysKey,
  sendChord,
  insertText,
  runCommand,
  disabled,
  triggerRef,
  focusFromContext,
  onFocusFromContextHandled,
}: {
  projection: CapsuleCapabilityProjection;
  /** How a capability's body reaches the terminal — the capsule owns this. */
  sendText: (text: string) => void;
  sendPhysKey?: (key: {
    seq?: string;
    semanticKey?: import('@/platform/terminal-runtime/interaction/TerminalInteractionController').TerminalSemanticKey;
  }) => void;
  sendChord?: (
    modifier: import('@/platform/terminal-runtime/interaction/TerminalInteractionController').TerminalChordModifier,
    key: import('@/platform/terminal-runtime/interaction/TerminalInteractionController').TerminalChordKey,
  ) => void;
  insertText: (text: string) => void;
  runCommand: (text: string) => void;
  disabled: boolean;
  /** Stable lower-Capsule trigger that owns focus when this upper layer closes. */
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  /** Only explicit Context-row deepening should move focus out of the composer. */
  focusFromContext: boolean;
  /** Clears the one-shot Context focus intent after the host consumes it. */
  onFocusFromContextHandled: () => void;
}) {
  const [focus, setFocus] = useState<string | undefined>(undefined);
  const surfaceRef = useRef<HTMLDivElement>(null);
  // The approved child overlay (#1120). Held here rather than by the capability
  // so that placement, dismissal and the accessible name stay the host's — a
  // capability supplies content and nothing else, exactly as it does for the
  // body itself.
  const [detail, setDetail] = useState<CapsuleDetail | null>(null);
  const { title, onOpenWorkspace } = projection;

  usePeekFocusLifecycle({
    focusFromContext,
    onFocusFromContextHandled,
    projectionId: projection.id,
    surfaceRef,
    triggerRef,
  });

  return (
    <div
      ref={surfaceRef}
      tabIndex={-1}
      role="region"
      aria-label={`${title} Peek`}
      data-testid="capsule-capability-projection"
      data-capability={projection.id}
      className={[
        capsuleProjectionClass,
        capsuleProjectionDockClass,
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
      ].join(' ')}
    >
      <PeekHeader projection={projection} />

      {projection.body(focus, setFocus, {
        sendText,
        sendPhysKey,
        sendChord,
        insertText,
        runCommand,
        // Bound here rather than in the hook, because `focus` is this
        // component's state: the deepening a capability offers is *at the item
        // the user picked*, and only the host knows which that was.
        openWorkspace: (resourceId) => onOpenWorkspace?.(resourceId ?? focus),
        openDetail: setDetail,
        disabled,
      })}

      {/*
        The Workspace destination (#1347 SC-21). Nession-owned: presence comes
        from the app layer's Workspace view registry (a capability without one
        — Terminal Keys — supplies no `onOpenWorkspace` and gets no action),
        placement and presentation are this host's, and the handoff carries
        the item the body reported, exactly like the body's own content rows.
      */}
      {onOpenWorkspace ? (
        <div className="flex justify-end">
          <button
            type="button"
            data-testid="capsule-capability-open-workspace"
            onClick={() => onOpenWorkspace(focus)}
            className={capsulePeekActionClass}
          >
            Open in Workspace →
          </button>
        </div>
      ) : null}

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
        {/* The radius is overridden here rather than in `components/ui/dialog`:
            that file is the shared primitive, and its generic default is right
            for a dialog in general — teaching it the capsule would be the
            primitive learning product semantics. This surface is the capsule's
            own, and it wears the capsule's corner: the same one the Peek behind
            it and the resting Capsule below it wear, so opening a child overlay
            does not change the shape of the thing it came out of. */}
        <DialogContent
          data-testid="capsule-capability-detail"
          className={capsuleDetailDialogClass}
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
/**
 * The upper slot's header: identity on the left, dismissal on the right.
 *
 * Extracted so the host's render stays one expression per region and so the
 * switch/title choice has a single owner; the close control is still the one
 * dismissal action either way (#2710).
 */
function PeekHeader({ projection }: { projection: CapsuleCapabilityProjection }) {
  return (
    <div className={capsuleUpperHeaderClass}>
      {projection.viewSwitch ? (
        <CapsuleViewSwitch viewSwitch={projection.viewSwitch} />
      ) : (
        /* The title names the projection. It is not a control: there is only
           one depth, so there is nothing behind it to open — it used to be the
           Signal's way in. */
        <h2 data-testid="capsule-capability-title" className={capsuleUpperTitleClass}>
          {projection.title}
        </h2>
      )}
      <button
        type="button"
        data-testid="capsule-capability-dismiss"
        aria-label={`Dismiss ${projection.title}`}
        onClick={() => projection.onDismiss()}
        className={capsuleUpperCloseButtonClass}
      >
        <CapsuleIconVisual>
          <X />
        </CapsuleIconVisual>
      </button>
    </div>
  );
}

/**
 * The compact header switch between peer capability views (#2710).
 *
 * A group of pressed-state buttons, not a tab widget: the options select a
 * capability (the app's one selection path), and there is no roving tabindex or
 * tabpanel to keep honest. The surface's own `aria-label` still names the
 * capability currently showing, so a screen reader hears the view it is in.
 */
function CapsuleViewSwitch({ viewSwitch }: { viewSwitch: CapsuleCapabilityViewSwitch }) {
  return (
    <div
      role="group"
      aria-label="Terminal tools"
      data-testid="capsule-view-switch"
      className={capsuleUpperSwitchClass}
    >
      {viewSwitch.options.map((option) => (
        <button
          key={option.id}
          type="button"
          data-testid={`capsule-view-${option.id}`}
          aria-pressed={option.selected}
          onClick={() => {
            if (!option.selected) {
              viewSwitch.onSelect(option.id);
            }
          }}
          className={capsuleUpperSwitchOptionClass(option.selected)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function usePeekFocusLifecycle({
  focusFromContext,
  onFocusFromContextHandled,
  projectionId,
  surfaceRef,
  triggerRef,
}: {
  focusFromContext: boolean;
  onFocusFromContextHandled: () => void;
  projectionId: string;
  surfaceRef: React.RefObject<HTMLDivElement | null>;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const returnFocusToTriggerRef = useRef(false);

  useEffect(() => {
    if (!focusFromContext) {
      return;
    }
    returnFocusToTriggerRef.current = true;
    surfaceRef.current?.focus({ preventScroll: true });
    onFocusFromContextHandled();
  }, [focusFromContext, onFocusFromContextHandled, projectionId, surfaceRef]);

  useEffect(
    () => () => {
      if (!returnFocusToTriggerRef.current) {
        return;
      }
      const active = document.activeElement;
      const stranded = active === null || active === document.body || surfaceRef.current?.contains(active);
      if (stranded) {
        triggerRef.current?.focus({ preventScroll: true });
      }
    },
    [surfaceRef, triggerRef],
  );
}

