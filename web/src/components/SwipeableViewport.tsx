import { useState, useRef, useCallback, type TouchEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface SwipeableViewportProps {
  children: ReactNode[];
  activeIndex: number;
  onIndexChange: (index: number) => void;
}

const SWIPE_THRESHOLD = 50; // px — minimum horizontal delta to trigger switch
const DIRECTION_LOCK_RATIO = 1.5; // |deltaX| must be > |deltaY| * this to count as horizontal

/**
 * Horizontally-swipeable panel viewport. Renders children side-by-side
 * and translates between them via CSS transform. Touch-driven with
 * directional locking so vertical scrolls inside panels don't trigger
 * horizontal switches.
 *
 * Panels are positioned at translateX(-100% * activeIndex). During a
 * drag the transform follows the finger (no transition). On release:
 * above threshold → snap to new index, below → snap back to original.
 */
export function SwipeableViewport({
  children,
  activeIndex,
  onIndexChange,
}: SwipeableViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const dragOffsetRef = useRef(0); // ref for latest value — avoids stale closure in touchEnd
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false); // ref for handleTouchMove — avoids stale closure
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const lockedRef = useRef<'horizontal' | 'vertical' | null>(null);

  const handleTouchStart = useCallback((e: TouchEvent) => {
    const touch = e.touches[0];
    startXRef.current = touch.clientX;
    startYRef.current = touch.clientY;
    lockedRef.current = null;
    setIsDragging(true);
    isDraggingRef.current = true;
    setDragOffset(0);
    dragOffsetRef.current = 0;
  }, []);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!isDraggingRef.current) {
      return;
    }
    const touch = e.touches[0];
    const deltaX = touch.clientX - startXRef.current;
    const deltaY = touch.clientY - startYRef.current;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);

    // Lock direction on first significant move
    if (lockedRef.current === null) {
      if (absX > 10 || absY > 10) {
        lockedRef.current = absX > absY * DIRECTION_LOCK_RATIO ? 'horizontal' : 'vertical';
      }
      return;
    }

    if (lockedRef.current === 'horizontal') {
      e.preventDefault();
      dragOffsetRef.current = deltaX;
      setDragOffset(deltaX);
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (!isDraggingRef.current) {
      return;
    }
    setIsDragging(false);
    isDraggingRef.current = false;

    const finalOffset = dragOffsetRef.current;
    const absDelta = Math.abs(finalOffset);
    if (absDelta > SWIPE_THRESHOLD) {
      const direction = finalOffset > 0 ? -1 : 1;
      const newIndex = Math.max(0, Math.min(children.length - 1, activeIndex + direction));
      if (newIndex !== activeIndex) {
        onIndexChange(newIndex);
      }
    }
    setDragOffset(0);
    dragOffsetRef.current = 0;
    lockedRef.current = null;
  }, [activeIndex, children.length, onIndexChange]);

  // CSS translateX(%) is relative to the element's own width.
  // The inner flex container is children.length * 100% wide (e.g. 300% for 3 panels).
  // Convert pixel offset to CSS %: percent = pixelOffset * 100 / (viewportWidth * children.length)
  const viewportWidth = containerRef.current?.offsetWidth || 1;
  const pixelOffset = -(activeIndex * viewportWidth) + dragOffset;
  const translateX = (pixelOffset * 100) / (viewportWidth * children.length);

  return (
    <div
      ref={containerRef}
      className="flex-1 min-h-0 overflow-hidden relative"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <div
        className={cn(
          'flex h-full',
          !isDragging && 'transition-transform duration-200',
        )}
        style={{
          transform: `translateX(${translateX}%)`,
          width: `${children.length * 100}%`,
        }}
      >
        {children.map((child, i) => (
          <div key={i} className="flex-1 min-w-0 h-full overflow-hidden">
            {child}
          </div>
        ))}
      </div>
    </div>
  );
}
