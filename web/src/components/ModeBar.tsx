import { useRef } from 'react';
import { cn } from '@/lib/utils';

interface ModeBarProps {
  count: number;
  activeIndex: number;
  dragOffset: number;
  isDragging: boolean;
}

/**
 * A 2px signature indicator bar at the top of SwipeableViewport.
 * A primary-colored segment (1/count of the total width) slides
 * between positions to show which panel is active.
 *
 * During drag the segment follows the finger in real-time (no transition).
 * On release it springs to the nearest full position via CSS transition.
 */
export function ModeBar({
  count,
  activeIndex,
  dragOffset,
  isDragging,
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
      className="absolute top-0 left-0 right-0 h-[2px] bg-muted/20 z-10"
      aria-hidden
    >
      <div
        className={cn(
          'h-full bg-primary',
          !isDragging && 'transition-[left] duration-300 ease-out',
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
