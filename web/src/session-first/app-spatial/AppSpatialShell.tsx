import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { PanelLeft, PanelRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useEdgeSwipePager } from './useEdgeSwipePager';

const FALLBACK_WIDTH_PX = 375;

export type SpatialPageIndex = 0 | 1 | 2;

export interface AppSpatialShellProps {
  sessions: ReactNode;
  terminal: ReactNode;
  workspace: ReactNode;
  index: SpatialPageIndex;
  onIndexChange: (index: SpatialPageIndex) => void;
  /** Overlay Sessions/Workspace buttons on the terminal page */
  showHeaderActions?: boolean;
}

export function AppSpatialShell({
  sessions,
  terminal,
  workspace,
  index,
  onIndexChange,
  showHeaderActions = false,
}: AppSpatialShellProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH_PX);

  useEffect(() => {
    const el = shellRef.current;
    if (!el) {
      return;
    }

    const measure = () => {
      const next = el.getBoundingClientRect().width;
      if (next > 0) {
        setWidth(next);
      }
    };

    measure();

    const observer = new ResizeObserver(() => {
      measure();
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);

  const handleIndexChange = useCallback(
    (next: number) => {
      if (next === 0 || next === 1 || next === 2) {
        onIndexChange(next);
      }
    },
    [onIndexChange],
  );

  const { dragOffset, onTouchStart, onTouchMove, onTouchEnd, onTouchCancel } =
    useEdgeSwipePager({
      pageCount: 3,
      index,
      onIndexChange: handleIndexChange,
      width,
    });

  const translateX = -index * width + dragOffset;

  return (
    <div
      ref={shellRef}
      data-testid="app-spatial-shell"
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <div
        className="relative min-h-0 flex-1 overflow-hidden"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
      >
        <div
          className="flex h-full will-change-transform"
          style={{
            width: width * 3,
            transform: `translateX(${translateX}px)`,
          }}
        >
          <div
            data-testid="app-spatial-page-sessions"
            className="h-full shrink-0 overflow-hidden"
            style={{ width }}
          >
            {sessions}
          </div>
          <div
            data-testid="app-spatial-page-terminal"
            className="relative h-full shrink-0 overflow-hidden"
            style={{ width }}
          >
            {terminal}
            {showHeaderActions ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute top-2 left-2 z-10 size-11"
                  aria-label="Sessions"
                  data-testid="app-spatial-open-sessions"
                  onClick={() => onIndexChange(0)}
                >
                  <PanelLeft className="size-5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute top-2 right-2 z-10 size-11"
                  aria-label="Workspace"
                  data-testid="app-spatial-open-workspace"
                  onClick={() => onIndexChange(2)}
                >
                  <PanelRight className="size-5" />
                </Button>
              </>
            ) : null}
          </div>
          <div
            data-testid="app-spatial-page-workspace"
            className="h-full shrink-0 overflow-hidden"
            style={{ width }}
          >
            {workspace}
          </div>
        </div>
      </div>
    </div>
  );
}
