import { useRef, useEffect } from 'react';
import { cn } from '@/shared/lib/utils';
import type { CapabilityId } from '@/product/capability';
import { WORKSPACE_VIEW_BINDINGS } from '@/app/workspace/viewBindings';
import type { WorkspacePresentationItem } from '@/app/workspace/presentation';
import {
  capsuleIconButtonClass,
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
            <button
              key={item.snapshot.id}
              ref={isActive ? activeItemRef : undefined}
              id={`workspace-capability-${item.snapshot.id}`}
              type="button"
              disabled={isUnavailable}
              aria-pressed={isActive}
              aria-label={item.snapshot.title}
              title={item.snapshot.title}
              data-testid={`workspace-tool-${item.snapshot.id}`}
              data-capability-state={item.snapshot.state}
              data-capability-presence={item.presence.level}
              data-capability-active={isActive ? 'true' : undefined}
              onClick={() => onSelect(item.snapshot.id)}
              className={cn(
                // The capsule's own control vocabulary, not a dock-local size:
                // `control-md` hit target with the `control-visual-size` circle
                // drawn inside it (#1034), so a capability entry is the same
                // object as a Conversation entry — 44/36 on App, 32/32 on Web.
                capsuleIconButtonClass,
                'relative inline-flex items-center justify-center transition-colors duration-[var(--motion-shell-duration)] ease-[var(--motion-shell-ease)]',
                isUnavailable
                  ? 'cursor-default text-disabled-foreground'
                  : isActive
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <CapsuleIconVisual>
                <Icon className="size-[length:var(--icon-md)]" aria-hidden />
              </CapsuleIconVisual>
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
        })}
      </div>
    </nav>
  );
}
