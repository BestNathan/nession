import { useRef, useEffect } from 'react';
import { cn } from '@/shared/lib/utils';
import type { CapabilityId } from '@/product/capability';
import { WORKSPACE_VIEW_BINDINGS } from '@/app/workspace/viewBindings';
import type { WorkspacePresentationItem } from '@/app/workspace/presentation';
import {
  capsuleShellSurfaceClass,
  capsuleShellPillRadiusClass,
  capsuleShellInnerPadClass,
} from '@/product/terminal/capsule/capsuleStyles';

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
      className={cn(
        'pointer-events-auto flex items-center',
        capsuleShellSurfaceClass,
        capsuleShellPillRadiusClass,
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

          return (
            <button
              key={item.snapshot.id}
              ref={isActive ? activeItemRef : undefined}
              id={`workspace-capability-${item.snapshot.id}`}
              type="button"
              aria-pressed={isActive}
              aria-label={item.snapshot.title}
              title={item.snapshot.title}
              data-testid={`workspace-tool-${item.snapshot.id}`}
              data-capability-state={item.snapshot.state}
              data-capability-presence={item.presence.level}
              data-capability-active={isActive ? 'true' : undefined}
              onClick={() => onSelect(item.snapshot.id)}
              className={cn(
                'relative flex size-[length:var(--dock-target)] shrink-0 items-center justify-center rounded-[var(--radius-control)] transition-colors duration-[var(--motion-shell-duration)] ease-[var(--motion-shell-ease)]',
                isActive
                  ? 'text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="size-[length:var(--icon-md)]" aria-hidden />
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
