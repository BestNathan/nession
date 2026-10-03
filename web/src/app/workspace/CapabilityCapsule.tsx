import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/shared/lib/utils';
import type { CapabilityId } from '@/product/capability';
import { WORKSPACE_VIEW_BINDINGS } from '@/app/workspace/viewBindings';
import type { WorkspacePresentationItem } from '@/app/workspace/presentation';
import {
  capsuleShellCapsuleRadiusClass,
  capsuleShellInnerPadClass,
  capsuleShellPillRadiusClass,
  capsuleShellSurfaceClass,
} from '@/product/terminal/capsule/capsuleStyles';
import { CapsuleIconVisual } from '@/product/terminal/capsule/CapsuleIconVisual';
import type { CapsuleExperience } from '@/product/terminal/capsule/types';

const workspaceViewBindings = new Map(
  WORKSPACE_VIEW_BINDINGS.map((view) => [view.id, view]),
);

interface CapabilityCapsuleProps {
  /** Capabilities with direct presence in the capsule row. */
  items: WorkspacePresentationItem[];
  /** Currently active capability. */
  activeCapabilityId: CapabilityId;
  /** Callback when a capability is selected. */
  onSelect: (id: CapabilityId) => void;
  /**
   * Which Capsule the Workspace form belongs to (#1347 SC-08 / SC-29).
   *
   * The two experiences answer differently and both answers are settled. On Web
   * the reciprocal pair draws both forms as pills, so this form is a pill. On
   * App there is one Capsule with two states, so this form wears the
   * Conversation form's outer geometry — the same semantic radius, the same
   * `control-md` vertical mass, the same App dock placement (the zone carries
   * it) — and differs only in what is inside it. The owner decision
   * (2026-10-03) made that continuity an acceptance rule: the old compact dock
   * language (`touchTarget.compact`, `dockTarget`, 28px) is retired rather than
   * protected.
   */
  experience: CapsuleExperience;
}

/**
 * Workspace capability capsule — the reciprocal of Terminal's conversation capsule.
 *
 * Capsule V2 (#1347): Terminal uses long capsule left + circle right; Workspace
 * uses circle left + long capsule right. This component is the long capsule on
 * the right side of Workspace.
 *
 * **Morphology:**
 * - Capsule shape (pill radius) matching Terminal's visual language
 * - Horizontal scrollable row of capability icons
 * - NO `+` button — discoverable capabilities accessed through other means
 * - Bounded width with internal scroll
 * - Active capability marked and scrolled into view
 *
 * **Reciprocal transition:** Terminal = `[capsule] [circle]`; Workspace = `[circle] [capsule]`.
 * The two forms share the same bottom Capsule Zone (transparent background).
 */
export function CapabilityCapsule({
  items,
  activeCapabilityId,
  onSelect,
  experience,
}: CapabilityCapsuleProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeItemRef = useRef<HTMLButtonElement>(null);

  /**
   * Scroll the active capability into view on mount and when it changes.
   *
   * The capsule has bounded width and internal scroll, so a capability that is
   * off-screen must be brought into view. `behavior: 'smooth'` provides visual
   * continuity; `block: 'nearest'` avoids unnecessary vertical scroll (though
   * this is a horizontal scroller, the API requires both).
   *
   * Guarded by a feature check: jsdom (used by Vitest) does not implement
   * `scrollIntoView`, so the call is skipped in test environments.
   */
  useEffect(() => {
    if (activeItemRef.current && scrollRef.current && typeof activeItemRef.current.scrollIntoView === 'function') {
      activeItemRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest',
      });
    }
  }, [activeCapabilityId]);

  return (
    <nav
      aria-label="Workspace capabilities"
      data-testid="workspace-capability-capsule"
      /* Reciprocal morph key (#1347 SC-08): the Terminal's capsule shell
         carries the same id, so a surface switch slides each from the
         other's former place. */
      data-morph-id="capsule-shell"
      data-shell-shape={experience === 'app' ? 'capsule' : 'pill'}
      className={cn(
        // `min-h-[control-md]` matches `CapsuleShell`'s own row: on App that is
        // the 44px control band the Conversation form uses, so the two states
        // have the same vertical mass; on Web it is a no-op at today's density.
        'pointer-events-auto flex min-h-[length:var(--control-md)] items-center',
        capsuleShellSurfaceClass,
        experience === 'app' ? capsuleShellCapsuleRadiusClass : capsuleShellPillRadiusClass,
        capsuleShellInnerPadClass,
      )}
    >
      <div
        ref={scrollRef}
        className="flex items-center gap-[length:var(--terminal-capsule-control-gap)] overflow-x-auto"
        data-testid="workspace-capability-scroll"
      >
        {items.map((item) => {
          const binding = workspaceViewBindings.get(item.snapshot.id);
          if (!binding) {
            return null;
          }

          const Icon = binding.icon;
          const isActive = item.snapshot.id === activeCapabilityId;
          // `unavailable` is the one state the reader cannot act from. It keeps
          // its slot — membership must not change under them as the work
          // changes — and is drawn inert instead: `disabled-foreground` is the
          // role the design system defines for a control that cannot be used,
          // held to the 3:1 that keeps it from disappearing rather than to AA.
          const isUnavailable = item.snapshot.state === 'unavailable';

          return (
            <CapabilityEntry
              key={item.snapshot.id}
              ref={isActive ? activeItemRef : undefined}
              id={`workspace-capability-${item.snapshot.id}`}
              title={item.snapshot.title}
              testId={`workspace-tool-${item.snapshot.id}`}
              state={item.snapshot.state}
              presence={item.presence.level}
              isActive={isActive}
              isUnavailable={isUnavailable}
              icon={<Icon className="size-[length:var(--icon-md)]" aria-hidden />}
              onSelect={() => onSelect(item.snapshot.id)}
            />
          );
        })}
      </div>
    </nav>
  );
}

interface CapabilityEntryProps {
  id: string;
  title: string;
  testId: string;
  state: string;
  presence: string;
  isActive: boolean;
  isUnavailable: boolean;
  icon: ReactNode;
  onSelect: () => void;
}

/**
 * One capability, as icon-over-label in a fixed-width slot.
 *
 * The slot is what bounds the row (the owner's follow-up to Capsule V2): a
 * long label wraps inside its slot instead of widening it, and a wrapped label
 * drops to the smaller type — measured by its own line count, not guessed from
 * the string, so the rule stays true if a title changes. Both sizes are
 * capsule tokens, so Web and App cannot drift apart.
 *
 * `CapsuleIconVisual` still draws the icon inside the same 36px affordance the
 * Conversation controls use (#1034): the entitlement split — hit target vs
 * painted circle — is unchanged, the label simply sits under it.
 */
const CapabilityEntry = forwardRef<HTMLButtonElement, CapabilityEntryProps>(
  function CapabilityEntry(
    { id, title, testId, state, presence, isActive, isUnavailable, icon, onSelect },
    ref,
  ) {
    const labelRef = useRef<HTMLSpanElement>(null);
    const [wrapped, setWrapped] = useState(false);

    /**
     * The font pick is by rendered line count: measure at the one-line size and
     * keep the smaller size once the label takes more than one line box. Never
     * evaluated back upward — the smaller size may fit on one line again, and
     * flipping back would oscillate the row.
     *
     * The count comes from a Range over the text, not from the span's own
     * client rects: `line-clamp` makes the span a `-webkit-box`, whose client
     * rects collapse to the single box — the range still reports one rect per
     * rendered line (the same measurement the e2e contract helper uses).
     */
    useLayoutEffect(() => {
      const el = labelRef.current;
      if (!el || wrapped) {
        return;
      }
      const range = document.createRange();
      // jsdom has no layout and no `Range.getClientRects` (the same reason the
      // scroll-into-view above is feature-checked); the browser path is the
      // one that measures, and browser verification is what proves it.
      if (typeof range.getClientRects !== 'function') {
        return;
      }
      range.selectNodeContents(el);
      if (range.getClientRects().length > 1) {
        setWrapped(true);
      }
    }, [wrapped, title]);

    return (
      <button
        ref={ref}
        id={id}
        type="button"
        disabled={isUnavailable}
        aria-pressed={isActive}
        aria-label={title}
        title={title}
        data-testid={testId}
        data-capability-state={state}
        data-capability-presence={presence}
        data-capability-active={isActive ? 'true' : undefined}
        onClick={onSelect}
        style={{ width: 'var(--terminal-capsule-capability-slot-width)' }}
        className={cn(
          'relative flex shrink-0 flex-col items-center justify-start gap-1 rounded-[var(--radius-control)] px-1 pt-1 pb-2 transition-colors duration-[var(--motion-shell-duration)] ease-[var(--motion-shell-ease)]',
          isUnavailable
            ? 'cursor-default text-disabled-foreground'
            : isActive
              ? 'text-foreground'
              : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <CapsuleIconVisual>{icon}</CapsuleIconVisual>
        <span
          ref={labelRef}
          data-testid={`${testId}-label`}
          className={cn(
            'line-clamp-2 text-center leading-tight',
            wrapped
              ? 'text-[length:var(--terminal-capsule-capability-label-wrapped-font-size)]'
              : 'text-[length:var(--terminal-capsule-capability-label-font-size)]',
          )}
        >
          {title}
        </span>
        {/* Active capability marked with dot indicator — same visual language
            as the previous dock, but now inside a capsule shape. The dot is
            always rendered so the row's geometry does not shift between states. */}
        <span
          aria-hidden
          className={cn(
            'absolute bottom-0.5 size-1 rounded-full',
            isActive ? 'bg-foreground' : 'bg-transparent',
          )}
        />
      </button>
    );
  },
);
