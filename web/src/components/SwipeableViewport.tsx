import { useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { ModeBar } from './ModeBar';
import { useSwipeGesture } from '@/hooks/useSwipeGesture';

interface SwipeableViewportProps {
  children: ReactNode[];
  activeIndex: number;
  onIndexChange: (index: number) => void;
}

/**
 * Horizontally-swipeable panel viewport. Renders children side-by-side
 * and translates between them via CSS transform. Touch-driven with
 * directional locking — vertical scrolls in panels don't trigger
 * horizontal switches.
 */
export function SwipeableViewport({
  children,
  activeIndex,
  onIndexChange,
}: SwipeableViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const {
    dragOffset,
    isDragging,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel,
  } = useSwipeGesture(children.length, activeIndex, onIndexChange);

  // CSS translateX(%) is relative to the element's own width.
  // Convert pixel offset to CSS %: percent = pixelOffset * 100 / (viewportWidth * children.length)
  const viewportWidth = containerRef.current?.offsetWidth || 1;
  const pixelOffset = -(activeIndex * viewportWidth) + dragOffset;
  const translateX = (pixelOffset * 100) / (viewportWidth * children.length);

  return (
    <div
      ref={containerRef}
      className="flex-1 min-h-0 overflow-hidden relative"
      style={{ touchAction: 'pan-y' }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
    >
      <ModeBar
        count={children.length}
        activeIndex={activeIndex}
        dragOffset={dragOffset}
        isDragging={isDragging}
      />
      <div
        className={cn(
          'flex h-full pt-[2px]',
          !isDragging && 'transition-transform duration-200',
        )}
        style={{
          transform: `translateX(${translateX}%)`,
          width: `${children.length * 100}%`,
        }}
      >
        {children.map((child, i) => (
          <div key={i} className="flex-1 min-w-0 h-full">
            {child}
          </div>
        ))}
      </div>
    </div>
  );
}
