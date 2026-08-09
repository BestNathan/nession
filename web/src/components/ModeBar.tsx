import { useRef } from 'react';
import { cn } from '@/lib/utils';

interface ModeBarProps {
  count: number;
  activeIndex: number;
  dragOffset: number;
  isDragging: boolean;
  /** When true the bar expands and glows — visual feedback for long-press swipe mode. */
  isLongPress?: boolean;
}

/**
 * A signature indicator bar at the top of SwipeableViewport.
 * A primary-colored segment (1/count of the total width) slides
 * between positions to show which panel is active.
 *
 * During drag the segment follows the finger in real-time (no transition).
 * On release it springs to the nearest full position via CSS transition.
 *
 * Long-press mode: expands from 2px → 4px with a subtle glow, signaling
 * that a horizontal swipe will now switch panels (avoids scroll conflicts).
 */
export function ModeBar({
  count,
  activeIndex,
  dragOffset,
  isDragging,
  isLongPress = false,
}: ModeBarProps) {
  const trackRef = useRef<HTMLDivElement>(null);

  const segmentPct = 100 / count; // e.g. 33.33% for 3 panels
  const baseLeft = activeIndex * segmentPct;

  // Convert pixel drag offset to percentage of the track width.
  const trackWidth = trackRef.current?.offsetWidth ?? 1;
  const offsetPct = (dragOffset / trackWidth) * segmentPct;

  // Thumb left edge, clamped so the segment never overflows the track.
  const left = Math.max(0, Math.min(100 - segmentPct, baseLeft - offsetPct));

  return (
    <div
      ref={trackRef}
      className={cn(
        'absolute top-0 left-0 right-0 z-10 bg-muted/20 transition-[height] duration-200',
        isLongPress ? 'h-1 shadow-[0_0_6px_1px] shadow-primary/30' : 'h-[2px]',
      )}
      aria-hidden
    >
      <div
        className={cn(
          'h-full bg-primary rounded-full',
          !isDragging && 'transition-[left] duration-300 ease-out',
          isLongPress && 'shadow-[0_0_4px] shadow-primary/50',
        )}
        style={{
          width: `${segmentPct}%`,
          position: 'absolute',
          left: `${left}%`,
        }}
      />
    </div>
  );
}
