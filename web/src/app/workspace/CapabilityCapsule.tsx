import { forwardRef, useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/shared/lib/utils';
import {
  resolveCapabilityCompactTitle,
  type CapabilityId,
} from '@/product/capability';
import { WORKSPACE_VIEW_BINDINGS } from '@/app/workspace/viewBindings';
import type { WorkspacePresentationItem } from '@/app/workspace/presentation';
import { capsuleOuterGeometry } from '@/product/terminal/capsule/capsuleStyles';
import type { CapsuleExperience } from '@/product/terminal/capsule/types';
import {
  workspaceCapabilityEntryClass,
  workspaceCapabilityEntryLayoutClass,
  workspaceCapabilityLabelAlignmentClass,
  workspaceCapabilityLabelBaseClass,
  workspaceCapabilityLabelSizeClass,
  workspaceCapabilityScrollClass,
  workspaceCapabilityStateClass,
} from '@/product/workspace/patterns/workspaceNavigationStyles';

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

  // Width is the one axis the derivation leaves to its consumer, because it is
  // a fact about the parent bar rather than about the Capsule: on App this nav
  // is the bar's only child, so it stretches to the bar's own inset — the same
  // horizontal edge the Conversation Form lands on, at every width. On Web the
  // bar also holds the surface action (`#1204`), so the nav sizes to its
  // content there and the row scrolls inside it (SC-06) instead.
  const geometry = capsuleOuterGeometry(
    experience,
    'flat',
    experience === 'app' ? 'stretch' : 'intrinsic',
  );

  return (
    <nav
      aria-label="Workspace capabilities"
      data-testid="workspace-capability-capsule"
      /* Reciprocal morph key (#1347 SC-08): the Terminal's capsule shell
         carries the same id, so a surface switch slides each from the
         other's former place. */
      data-morph-id="capsule-shell"
      data-shell-shape={geometry.shape}
      className={cn(
        // The Capability Form wears the Conversation Form's geometry, from the
        // same derivation `CapsuleShell` uses (#1347 SC-29/SC-30): the
        // canonical control.md band, shared surface/radius family, padding and
        // clipping. Content is contained inside that band; it never owns outer
        // Capsule height (#1455).
        //
        // The bound is what makes the INNER row scroll instead of the capsule
        // overhanging the tool bar (SC-06); which bound depends on the bar, and
        // the derivation call above states why.
        geometry.shellClass,
      )}
    >
      <div
        ref={scrollRef}
        className={workspaceCapabilityScrollClass}
        data-testid="workspace-capability-scroll"
      >
        {items.map((item) => {
          const binding = workspaceViewBindings.get(item.snapshot.id);
          if (!binding) {
            return null;
          }

          const Icon = binding.icon;
          const isActive = item.snapshot.id === activeCapabilityId;
          // Hidden/unavailable capabilities must not occupy Workspace chrome.
          // Keep this guard at the rendering boundary as well as in the
          // presentation model so a future caller cannot accidentally turn a
          // hidden capability into a disabled advertisement.
          if (item.snapshot.state === 'unavailable') {
            return null;
          }

          return (
            <CapabilityEntry
              key={item.snapshot.id}
              ref={isActive ? activeItemRef : undefined}
              id={`workspace-capability-${item.snapshot.id}`}
              title={item.snapshot.title}
              compactTitle={resolveCapabilityCompactTitle(item.snapshot)}
              testId={`workspace-tool-${item.snapshot.id}`}
              state={item.snapshot.state}
              presence={item.presence.level}
              isActive={isActive}
              experience={experience}
              icon={<Icon className="size-[length:var(--nession-icon-md)]" aria-hidden />}
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
  compactTitle: string;
  testId: string;
  state: string;
  presence: string;
  isActive: boolean;
  experience: CapsuleExperience;
  icon: ReactNode;
  onSelect: () => void;
}

/**
 * One capability in a fixed-width, fixed-height slot.
 *
 * Geometry belongs to WorkspaceNavigation, not the capability. Web uses a
 * horizontal icon+label composition inside the denser 32px band; App keeps the
 * icon-over-label composition inside its 44px touch band. The capability owns a
 * compact title for this constrained surface; aria-label/title keep the complete
 * capability name available. Truncation remains only a defensive viewport guard.
 *
 * The glyph stays bare rather than using CapsuleIconVisual: a labeled entry is
 * one affordance, not an icon button plus a second label.
 */
const CapabilityEntry = forwardRef<HTMLButtonElement, CapabilityEntryProps>(
  function CapabilityEntry(
    {
      id,
      title,
      compactTitle,
      testId,
      state,
      presence,
      isActive,
      experience,
      icon,
      onSelect,
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        id={id}
        type="button"
        aria-pressed={isActive}
        aria-label={title}
        title={title}
        data-testid={testId}
        data-capability-state={state}
        data-capability-presence={presence}
        data-capability-active={isActive ? 'true' : undefined}
        onClick={onSelect}
        className={cn(
          workspaceCapabilityEntryClass,
          workspaceCapabilityEntryLayoutClass(experience),
          workspaceCapabilityStateClass({ active: isActive }),
        )}
      >
        {icon}
        <span
          data-testid={`${testId}-label`}
          className={cn(
            workspaceCapabilityLabelBaseClass,
            workspaceCapabilityLabelSizeClass,
            workspaceCapabilityLabelAlignmentClass(experience),
          )}
        >
          {compactTitle}
        </span>
      </button>
    );
  },
);
