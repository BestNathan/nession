import { cn } from '@/shared/lib/utils';

const SIZE = 28;
const STROKE = 2.5;
const R = (SIZE - STROKE) / 2;
const C = 2 * Math.PI * R;

/**
 * Circular pull progress for loading older transcript messages (#1190).
 */
export function TranscriptPullToLoadIndicator({
  progress,
  className,
}: {
  progress: number;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(1, progress));
  const offset = C * (1 - clamped);

  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className={cn('shrink-0 text-muted-foreground', className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      aria-label="Pull to load earlier messages"
    >
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={R}
        fill="none"
        stroke="currentColor"
        strokeWidth={STROKE}
        opacity={0.25}
      />
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={R}
        fill="none"
        stroke="var(--primary)"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeDasharray={C}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
      />
    </svg>
  );
}
