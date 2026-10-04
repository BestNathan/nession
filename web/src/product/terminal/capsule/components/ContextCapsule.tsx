import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { cn } from '@/shared/lib/utils';
import {
  contextCapsuleDockClass,
  contextCapsuleIconSlotClass,
  contextCapsuleMarkerClass,
  contextCapsuleMarkerSlotClass,
  contextCapsuleReasonClass,
  contextCapsuleRowClass,
  contextCapsuleScrollClass,
  contextCapsuleSurfaceClass,
  contextCapsuleTitleClass,
} from '@/product/terminal/capsule/capsuleStyles';
import { CONTEXT_CAPSULE_ID } from '@/product/terminal/capsule/contextCapsuleId';
import { resolveContextRows, sensedWorkItems, type ContextRow } from '@/product/terminal/capsule/contextRows';
import type { CapsuleCapabilityDisclosure } from '@/product/terminal/capsule/types';
import type { ResolvedWorkContext } from '@/product/terminal/capsule/workAwareness';

export interface ContextCapsuleProps {
  disclosure: CapsuleCapabilityDisclosure;
  workContext?: ResolvedWorkContext;
  /** Close the surface. The lower Capsule is not this component's to move. */
  onDismiss: () => void;
  /** The `+` that opened this surface — where focus goes when it closes. */
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}

/**
 * The upper Context Capsule (#1347 SC-41–44).
 *
 * A sibling of the Conversation Capsule inside the same dock — never a popup,
 * never a replacement. The owner's correction is the whole design: tapping `+`
 * leaves the lower Capsule visible, unchanged and spatially stable, and adds
 * this surface above it, one inter-Capsule gap away.
 *
 * What it renders is **one flat list**: the capabilities sensed right now first
 * (work-sensed, then context-sensed), the ordinary catalog in the same list
 * below them. There is no second step — no `All capabilities`, no submenu — so
 * a capability is never more than one row away, and `resolveContextRows` is what
 * keeps a sensed capability from also appearing in the catalog half.
 *
 * Its height is fixed and identical in every sense state, so the pair does not
 * jump as rows come and go (SC-44); overflow scrolls inside it and no other
 * gesture belongs to it.
 *
 * The trigger (`+`) is not here: it lives in the composer row and points at this
 * surface with `aria-controls`.
 */
export function ContextCapsule({ disclosure, workContext, onDismiss, triggerRef }: ContextCapsuleProps) {
  const rows = useMemo(
    () =>
      resolveContextRows(
        sensedWorkItems(workContext, disclosure.entries),
        disclosure.sensedContext ?? [],
        disclosure.entries,
      ),
    [disclosure.entries, disclosure.sensedContext, workContext],
  );

  const surfaceRef = useRef<HTMLDivElement>(null);
  const firstRowRef = useRef<HTMLButtonElement>(null);

  // Focus enters the surface when it opens. This is what the menu primitive did
  // before the list became a Capsule, and on App it matters more rather than
  // less: the field the user was typing in must not hold the IME open over the
  // surface they just asked for.
  useEffect(() => {
    firstRowRef.current?.focus();
  }, []);

  // …and leaves it again when the surface closes, back on the control that
  // opened it. The menu primitive did this for free and the Capsule inherited
  // the obligation with the surface: without it every dismissal — Escape, a
  // pointer outside, the trigger, or picking a row — drops focus on `body`, and
  // a keyboard user restarts from the top of the document.
  //
  // Guarded, because "dismissed" is not the same as "the user is done with the
  // surface": a sense that ends while someone is typing in the composer (SC-36)
  // unmounts this component too, and yanking focus out of the field they are
  // using would be worse than the bug. Focus is only taken back when it would
  // otherwise be lost — still inside the surface, or already fallen to `body`
  // because the focused row just left the DOM.
  useEffect(
    () => () => {
      const active = document.activeElement;
      const stranded = active === null || active === document.body || surfaceRef.current?.contains(active);
      if (stranded) {
        triggerRef.current?.focus();
      }
    },
    [surfaceRef, triggerRef],
  );

  useDismissOnEscapeAndOutside(surfaceRef, onDismiss);

  // SC-36: a sense that ends while the list is open dismisses it, the way the
  // ring goes out. The rule survives the surface changing from a menu to a
  // Capsule — it was never about the primitive — but it now has to be stated
  // here rather than inherited from a `sawSensed` effect the menu owned.
  //
  // A Peek the user opened is a different case: it lives in this same slot but
  // answers to the user, not to sensing, which is why the projection path does
  // not dismiss itself.
  const sensedCount = rows.filter((row) => row.kind !== 'ordinary').length;
  const sawSensed = useRef(false);
  useEffect(() => {
    if (sensedCount > 0) {
      sawSensed.current = true;
    } else if (sawSensed.current) {
      onDismiss();
    }
  }, [onDismiss, sensedCount]);

  const select = (row: ContextRow) => {
    // Every row opens its capability at Peek depth — the detail (#1347 SC-20).
    // Sensed and ordinary rows behave alike: picking something in this list is
    // asking to look at it, and the Peek is where the way on to the Workspace
    // lives. The surface closes because the Peek takes this same slot.
    disclosure.onSelect(row.capabilityId);
    onDismiss();
  };

  return (
    <div
      ref={surfaceRef}
      /* Named as the Context Disclosure rather than as a menu: it is the surface
         SC-18 names, and eight specs already select it. The id is the same
         string, shared so the trigger's `aria-controls` cannot drift from it. */
      id={CONTEXT_CAPSULE_ID}
      data-testid={CONTEXT_CAPSULE_ID}
      data-capsule-part="context"
      data-shell-shape="capsule"
      role="group"
      aria-label="Capabilities"
      className={cn(contextCapsuleDockClass, contextCapsuleSurfaceClass)}
    >
      <div className={contextCapsuleScrollClass} data-testid="capsule-context-scroll">
        {rows.map((row, index) => (
          <ContextRowButton
            key={row.capabilityId}
            ref={index === 0 ? firstRowRef : undefined}
            row={row}
            onSelect={() => select(row)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One row, and the whole row is the control.
 *
 * A real `<button>`, not a `role="menuitem"`: an ARIA menu without roving
 * tabindex is worse than no menu at all, and every row here is naturally
 * tabbable in the order it is read.
 */
function ContextRowButton({
  ref,
  row,
  onSelect,
}: {
  ref?: React.Ref<HTMLButtonElement>;
  row: ContextRow;
  onSelect: () => void;
}) {
  const Icon = row.icon;
  // Only a capability the session actually needs is marked, and only an
  // ordinary row can be: a sensed row's presence is the reason line's job.
  const perceived =
    row.kind === 'ordinary' && (row.state === 'relevant' || row.state === 'active');

  return (
    <button
      ref={ref}
      type="button"
      /* The sensed rows keep `capsule-context-item-…`, the ordinary ones
         `capsule-capability-picker-…`: those two names are how the specs say
         which half of the list they mean, and they are the only thing that
         distinguishes the halves now that both are rows in one surface. */
      data-testid={
        row.kind === 'ordinary'
          ? `capsule-capability-picker-${row.capabilityId}`
          : `capsule-context-item-${row.capabilityId}`
      }
      data-context-row={row.kind}
      data-capability-state={row.state}
      onClick={onSelect}
      className={contextCapsuleRowClass}
    >
      {/* The presence mark's column, on every row. It used to be rendered
          only for ordinary rows, which pushed their titles 6px right of a
          sensed row's (measured on staging: x=44 against x=50) — two
          different left edges in one list. The column is always present so
          the icon and title columns start at the same offset whether or not
          a dot is drawn. */}
      <span aria-hidden data-testid="capsule-row-marker" className={contextCapsuleMarkerSlotClass}>
        {perceived ? <span className={contextCapsuleMarkerClass} /> : null}
      </span>
      <span className={contextCapsuleIconSlotClass} aria-hidden>
        {Icon ? <Icon className="size-[length:var(--icon-md)]" /> : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        {/* Only an `unavailable` capability is muted. An `available` one is
            reachable and listed for exactly that reason (SC-35), so drawing
            it in the disabled colour said the opposite of what the row is:
            `available` and `relevant` now read alike, and the 5px mark is
            what tells them apart. */}
        <span className={cn(contextCapsuleTitleClass, row.state === 'unavailable' && 'text-muted-foreground')}>
          {row.title}
        </span>
        {row.reason === undefined ? null : (
          <span className={contextCapsuleReasonClass}>{row.reason}</span>
        )}
      </span>
      {/* No drill-in chevron. It is the strongest "this is a dropdown menu"
          tell on a surface SC-42 says must not read as one, and it is not
          even honest: picking a row deepens it in place rather than
          navigating anywhere. */}
    </button>
  );
}

/**
 * Dismissal for an in-flow surface: Escape, or a pointer that lands outside.
 *
 * The surface is not a popup, so nothing gives this for free — and the escape
 * key has a second job here that a menu never had to think about: the Terminal
 * below is listening for it. `stopPropagation` is what keeps dismissing the
 * list from also sending an escape to whatever is running in the session.
 */
function useDismissOnEscapeAndOutside(
  surfaceRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      event.stopPropagation();
      onDismiss();
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (surfaceRef.current?.contains(target)) {
        return;
      }
      // The trigger's own click toggles the surface; dismissing here as well
      // would close it twice and reopen it once.
      if (target instanceof Element && target.closest('[data-testid="capsule-capability-more"]')) {
        return;
      }
      onDismiss();
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [onDismiss, surfaceRef]);
}
