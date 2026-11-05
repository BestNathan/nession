import type { ReactNode } from 'react';

export interface AppLayerSlabProps {
  testId: string;
  x: number;
  moving: boolean;
  transition?: string;
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
export function AppLayerSlab({ testId, x, moving, transition, children }: AppLayerSlabProps) {
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
    >
      {children}
    </div>
  );
}
