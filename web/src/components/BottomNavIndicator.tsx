import { cn } from '@/lib/utils';

interface BottomNavIndicatorProps {
  count: number;
  activeIndex: number;
}

/**
 * Visual-only dot indicator for the current panel in SwipeableViewport.
 * Non-interactive — swipe is the primary navigation method.
 */
export function BottomNavIndicator({ count, activeIndex }: BottomNavIndicatorProps) {
  return (
    <div
      className="flex items-center justify-center gap-1.5 py-2"
      role="tablist"
      aria-label="Navigation panels"
    >
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          role="tab"
          aria-selected={i === activeIndex}
          aria-label={`Panel ${i + 1}`}
          className={cn(
            'size-2 rounded-full transition-colors duration-200',
            i === activeIndex ? 'bg-primary' : 'bg-muted',
          )}
        />
      ))}
    </div>
  );
}
