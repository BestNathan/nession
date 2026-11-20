import type { ReactNode, TransitionEvent } from 'react';

export interface AppLayerSlabProps {
  testId: string;
  x: number;
  moving: boolean;
  transition?: string;
  /** Called when this slab's own settle transform transition completes. */
  onSettled?: () => void;
  children: ReactNode;
}

/**
 * One sliding App layer over the Terminal (#1049, #2724).
 *
 * The transform is the layer's position and the shadow exists only while a
 * gesture is moving it; at rest the slab carries no inline shadow at all. The
 * `will-change-transform` is scoped to this element rather than the shell so
 * the static Terminal does not hold a compositor layer.
 */
export function AppLayerSlab({ testId, x, moving, transition, onSettled, children }: AppLayerSlabProps) {
  const handleTransitionEnd = onSettled === undefined
    ? undefined
    : (event: TransitionEvent<HTMLDivElement>) => {
      // Nested content can run its own transform transitions; only the slab's
      // own settle is the coordinator's signal (#4185).
      if (event.target === event.currentTarget && event.propertyName === 'transform') {
        onSettled();
      }
    };
  return (
    <div
      data-testid={testId}
      data-swipe-moving={moving ? 'true' : undefined}
      className="absolute inset-0 z-40 overflow-hidden will-change-transform"
      style={{
        transform: `translateX(${x}px)`,
        transition,
        boxShadow: moving ? 'var(--nession-elevation-floating)' : undefined,
      }}
      onTransitionEnd={handleTransitionEnd}
    >
      {children}
    </div>
  );
}
