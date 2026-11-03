import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react';
import type { ComponentType } from 'react';
import { cn } from '@/shared/lib/utils';
import { chromeLabelRole, chromeMonoRole } from '@/shared/typography/chromeRoles';
import type { DirectionPadDirection } from '../gesture/directionPadEngine';
import { DIRECTION_PAD_DIAL_SIZE } from '../gesture/directionPadGeometry';
import type { DirectionPadView } from '../gesture/directionPadView';

/** The overlay's input; the hook owns the same shape. */
export type DirectionPadOverlayView = DirectionPadView;

const ARROWS: ReadonlyArray<{
  direction: DirectionPadDirection;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  className: string;
}> = [
  { direction: 'up', icon: ArrowUp, className: 'left-1/2 top-1 -translate-x-1/2' },
  { direction: 'right', icon: ArrowRight, className: 'right-1 top-1/2 -translate-y-1/2' },
  { direction: 'down', icon: ArrowDown, className: 'bottom-1 left-1/2 -translate-x-1/2' },
  { direction: 'left', icon: ArrowLeft, className: 'left-1 top-1/2 -translate-y-1/2' },
];

/**
 * The touch direction pad's transient visual (#2657).
 *
 * Purely presentational and `pointer-events-none`: the gesture adapters keep
 * their DOM listeners on the window and on xterm's own elements, so the guide
 * must never become the touch target. It is centred on the anchored touch
 * point (clamped inside the viewport by the hook) and shows the real origin as
 * a dot when the clamp moved it.
 */
export function DirectionPadOverlay({ view }: { view: DirectionPadOverlayView | null }) {
  if (view === null) {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
    >
      {view.showOrigin ? (
        <span
          data-testid="terminal-direction-pad-origin"
          className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-primary"
          style={{ left: view.originX, top: view.originY }}
        />
      ) : null}
      <div
        data-testid="terminal-direction-pad"
        data-phase={view.phase}
        data-direction={view.direction ?? 'none'}
        className={cn(
          'absolute -translate-x-1/2 -translate-y-1/2 rounded-full',
          'border border-border/70 bg-popover/90 text-popover-foreground',
          'shadow-[var(--nession-elevation-floating)] backdrop-blur-sm',
        )}
        style={{
          left: view.anchorX,
          top: view.anchorY,
          width: DIRECTION_PAD_DIAL_SIZE,
          height: DIRECTION_PAD_DIAL_SIZE,
        }}
      >
        <span className="absolute inset-[21px] rounded-full border border-border/30" />
        <span className="absolute inset-[46px] rounded-full border border-primary/25" />

        {ARROWS.map((arrow) => {
          const active = view.direction === arrow.direction;
          return (
            <span
              key={arrow.direction}
              data-testid="terminal-direction-pad-arrow"
              data-direction={arrow.direction}
              data-active={active ? 'true' : 'false'}
              className={cn(
                'absolute flex size-12 items-center justify-center rounded-[var(--nession-radius-control)] border',
                arrow.className,
                active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-transparent text-muted-foreground',
              )}
            >
              <arrow.icon className="size-6" strokeWidth={2.25} />
            </span>
          );
        })}

        <span className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-0.5 rounded-[var(--nession-radius-control)] border border-border bg-background/90 px-3 py-2">
          <span data-testid="terminal-direction-pad-rate" className={chromeMonoRole('title')}>
            {view.direction === null ? '·' : `${view.rate}/s`}
          </span>
          <span
            data-testid="terminal-direction-pad-count"
            className={cn(chromeLabelRole('caption'), 'text-muted-foreground')}
          >
            {view.direction === null ? 'STOP' : `KEYS ${view.count}`}
          </span>
        </span>

        <span className="absolute -bottom-2 left-12 right-12 flex h-5 items-center gap-1.5 rounded-full border border-border bg-background/90 px-3">
          {[0, 1, 2, 3].map((band) => (
            <span
              key={band}
              data-testid="terminal-direction-pad-speed-pip"
              data-on={view.gear >= band ? 'true' : 'false'}
              className={cn(
                'h-1 flex-1 rounded-full',
                view.gear >= band ? 'bg-primary' : 'bg-muted',
              )}
            />
          ))}
        </span>
      </div>
    </div>
  );
}
