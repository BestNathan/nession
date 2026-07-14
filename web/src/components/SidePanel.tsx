import { useState, useCallback, useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SidePanelProps {
  children: React.ReactNode;
  defaultOpen?: boolean;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
}

/**
 * Collapsible, resizable side panel.
 *
 * Extensible: accepts any children. Currently hosts FileBrowser; future
 * sections (process monitor, etc.) can be added as siblings or tabs
 * inside PanelContent.
 */
export function SidePanel({
  children,
  defaultOpen = false,
  defaultWidth = 260,
  minWidth = 180,
  maxWidth = 480,
}: SidePanelProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [width, setWidth] = useState(defaultWidth);
  const isResizing = useRef(false);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    const startX = e.clientX;
    const startWidth = width;

    const onMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) {return;}
      const delta = e.clientX - startX;
      const newWidth = Math.min(maxWidth, Math.max(minWidth, startWidth + delta));
      setWidth(newWidth);
    };

    const onMouseUp = () => {
      isResizing.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [width, minWidth, maxWidth]);

  const toggle = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

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

      <div className="relative flex-shrink-0">
        {/* Panel content — fixed overlay below lg, inline (push) at lg+ */}
        <div
          className={cn(
            'border-r bg-muted/30 transition-all duration-200 overflow-hidden',
            'fixed inset-y-0 left-0 z-30 lg:static lg:z-auto lg:h-full',
            isOpen ? '' : 'w-0 border-r-0',
          )}
          style={{ width: isOpen ? width : 0 }}
        >
          <div className="h-full flex flex-col" style={{ width }}>
            {children}
          </div>

          {/* Resize handle — desktop only (push mode) */}
          {isOpen && (
            <div
              className="absolute top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/50 transition-colors z-10 hidden lg:block"
              style={{ right: -2 }}
              onMouseDown={startResize}
            />
          )}
        </div>

        {/* Toggle button */}
        <button
          onClick={toggle}
          className={cn(
            'fixed lg:absolute top-1/2 -translate-y-1/2 h-16 w-5 flex items-center justify-center',
            'border shadow-sm cursor-pointer transition-all z-40',
            isOpen
              ? 'bg-muted rounded-r-md hover:bg-accent lg:-right-5'
              : 'left-0 bg-background/60 rounded-r-md hover:bg-accent/80 opacity-50 hover:opacity-100',
          )}
          style={isOpen ? { left: width } : undefined}
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
