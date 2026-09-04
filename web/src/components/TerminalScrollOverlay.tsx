import { ChevronUp, ChevronDown, ArrowDownToLine } from 'lucide-react';
import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import {
  capsuleComposerGridGapClass,
  capsuleScrollOverlayButtonClass,
  capsuleScrollOverlaySurfaceClass,
} from '@/session-first/capsule/capsuleStyles';
import { cn } from '@/lib/utils';

interface TerminalScrollOverlayProps {
  /** Scroll the terminal scrollback by pages (negative = towards history). */
  onScrollPages: (pages: number) => void;
  /** Jump the terminal viewport to the newest output. */
  onScrollToBottom: () => void;
}

/**
 * Floating scroll controls pinned to the bottom-right of the terminal area
 * (mobile layout only — the desktop layout never mounts this component).
 * Touch devices have no scroll wheel, so these buttons are the explicit way
 * to page through xterm's scrollback and return to the newest output.
 *
 * Every button calls preventDefault() on pointerdown so tapping never moves
 * focus — the MobileImeInput textarea keeps focus and the on-screen keyboard
 * stays open. xterm's scroll APIs clamp at the buffer boundaries, so no
 * disabled state or extra clamping is needed here.
 */
export function TerminalScrollOverlay({
  onScrollPages,
  onScrollToBottom,
}: TerminalScrollOverlayProps) {
  return (
    <div
      className={cn(
        'absolute right-2 z-20 flex flex-col',
        capsuleComposerGridGapClass,
        capsuleScrollOverlaySurfaceClass,
        'bottom-[calc(var(--terminal-capsule-occlusion,0px)+0.5rem)]',
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className={capsuleScrollOverlayButtonClass}
              aria-label="Scroll up one page"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => onScrollPages(-1)}
            >
              <ChevronUp className="size-4" data-icon />
            </Button>
          }
        />
        <TooltipContent side="left">
          <p>Page up</p>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className={capsuleScrollOverlayButtonClass}
              aria-label="Scroll down one page"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => onScrollPages(1)}
            >
              <ChevronDown className="size-4" data-icon />
            </Button>
          }
        />
        <TooltipContent side="left">
          <p>Page down</p>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className={capsuleScrollOverlayButtonClass}
              aria-label="Scroll to bottom"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => onScrollToBottom()}
            >
              <ArrowDownToLine className="size-4" data-icon />
            </Button>
          }
        />
        <TooltipContent side="left">
          <p>Newest output</p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
