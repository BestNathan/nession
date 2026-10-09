/**
 * Work Ring — the partial ring around the `+` button when working.
 *
 * Capsule V2 (#1347): Working is indicated by a restrained static partial ring
 * around the internal `+`. Not a spinner, pulse, rotation, or count badge.
 *
 * **Design:**
 * - 270° arc (3/4 circle) — enough to be visible, not enough to be busy
 * - Uses the Capsule's quiet semantic state treatment, distinct from its surface
 * - Static (no animation) — motion is reserved for state transitions, not idle
 * - Positioned absolutely around the `+` button
 *
 * **Success Criteria:**
 * - SC-16: Working indicated without replacing `+` with plugin identity
 * - SC-17: Work Ring is not a spinner, counter, or persistent animation
 */
import { cn } from '@/shared/lib/utils';
import { capsuleWorkRingClass } from '@/product/terminal/capsule/capsuleStyles';

interface WorkRingProps {
  /** Whether to show the work ring (working state). */
  working: boolean;
  className?: string;
}

/**
 * Work Ring component — partial ring around the `+` button.
 *
 * Renders a 270° arc using SVG. The ring is static (no animation) and uses a
 * quiet semantic foreground owned by the Capsule grammar, so it remains visible
 * against the Capsule surface without competing with the primary action.
 */
export function WorkRing({ working, className }: WorkRingProps) {
  if (!working) {
    return null;
  }

  // SVG circle with stroke-dasharray to create a 270° arc.
  // Circumference = 2πr. For r=10, circumference ≈ 62.83.
  // 270° = 75% of circumference ≈ 47.12.
  const radius = 10;
  const circumference = 2 * Math.PI * radius;
  const arcLength = circumference * 0.75; // 270°

  return (
    <svg
      aria-hidden
      data-testid="work-ring"
      className={cn(
        'pointer-events-none absolute inset-0',
        className,
      )}
      viewBox="0 0 24 24"
    >
      <circle
        cx="12"
        cy="12"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray={`${arcLength} ${circumference}`}
        strokeLinecap="round"
        // Rotate so the gap is at the bottom-right (like a progress indicator).
        transform="rotate(-90 12 12)"
        className={capsuleWorkRingClass}
      />
    </svg>
  );
}
