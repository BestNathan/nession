import { useState, useCallback } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SidePanelProps {
  children: React.ReactNode;
  defaultOpen?: boolean;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  /** Called when the panel is toggled open/closed. */
  onOpenChange?: (open: boolean) => void;
}

/**
 * Collapsible side panel.
 *
 * Extensible: accepts any children. Currently hosts FileBrowser (FileTabs) and
 * the SessionPanel; future sections can be added as siblings or tabs.
 *
 * Resizing on desktop is handled by the parent via ResizablePanelGroup — this
 * component owns only the open/closed state. On mobile it renders as a fixed
 * overlay drawer (width = defaultWidth); at lg+ it fills its parent panel.
 *
 * NOTE: `minWidth` / `maxWidth` are kept on the interface for backward
 * compatibility; they are no longer used here (the parent ResizablePanelGroup
 * applies min/max constraints).
 */
export function SidePanel({
  children,
  defaultOpen = false,
  defaultWidth = 260,
  onOpenChange,
}: SidePanelProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  const toggle = useCallback(() => {
    setIsOpen((prev) => {
      const next = !prev;
      onOpenChange?.(next);
      return next;
    });
  }, [onOpenChange]);

  return (
    <>
      {/* Backdrop — only below lg, only when open. Dismisses the drawer. */}
      {isOpen && (
        <div
          data-testid="sidepanel-backdrop"
          className="fixed inset-0 z-20 bg-black/40 lg:hidden"
          onClick={() => setIsOpen(false)}
        />
      )}

      {/* --sp-width feeds the mobile drawer width (and the open button's left
          offset) so the desktop panel can stay fluid inside its ResizablePanel. */}
      <div
        className="relative flex-shrink-0 h-full"
        style={{ '--sp-width': `${defaultWidth}px` } as React.CSSProperties}
      >
        {/* Panel content — always rendered so the parent ResizablePanel
            doesn't collapse when closed. Hidden via CSS when isOpen=false. */}
        <div
          className={cn(
            'border-r bg-muted/30 overflow-hidden',
            'fixed inset-y-0 left-0 z-30 lg:static lg:z-auto lg:h-full',
            'w-[var(--sp-width)] lg:w-auto',
            !isOpen && 'lg:!block hidden',
          )}
        >
            <div className="h-full flex flex-col">{children}</div>
          </div>

        {/* Toggle button */}
        <button
          onClick={toggle}
          className={cn(
            'fixed lg:hidden top-1/2 -translate-y-1/2 h-16 w-5 flex items-center justify-center',
            'border shadow-sm cursor-pointer transition-all z-40',
            isOpen
              ? 'bg-muted rounded-r-md hover:bg-accent lg:-right-5 left-[var(--sp-width)] lg:left-auto'
              : 'bg-background/60 rounded-r-md hover:bg-accent/80 opacity-50 hover:opacity-100 left-0 lg:left-auto lg:right-0',
          )}
          title={isOpen ? 'Close panel' : 'Open panel'}
        >
          {isOpen ? (
            <ChevronLeft className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    </>
  );
}
