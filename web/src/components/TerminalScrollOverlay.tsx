import { ChevronUp, ChevronDown, ArrowDownToLine } from 'lucide-react';
import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

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
 * focus — the MobileInput textarea keeps focus and the on-screen keyboard
 * stays open. xterm's scroll APIs clamp at the buffer boundaries, so no
 * disabled state or extra clamping is needed here.
 */
export function TerminalScrollOverlay({
  onScrollPages,
  onScrollToBottom,
}: TerminalScrollOverlayProps) {
  return (
    <div className="absolute bottom-2 right-2 z-10 flex flex-col gap-0.5 rounded-lg border bg-background/80 backdrop-blur-sm p-1 shadow-md">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
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
              className="h-9 w-9"
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
              className="h-9 w-9"
              aria-label="Scroll to bottom"
              onPointerDown={(e) => e.preventDefault()}
              onClick={onScrollToBottom}
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
