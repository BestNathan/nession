import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useSwipePager } from './useSwipePager';

const FALLBACK_WIDTH_PX = 375;

export type SpatialPageIndex = 0 | 1 | 2;

export interface AppSpatialShellProps {
  sessions: ReactNode;
  terminal: ReactNode;
  workspace: ReactNode;
  index: SpatialPageIndex;
  onIndexChange: (index: SpatialPageIndex) => void;
}

export function AppSpatialShell({
  sessions,
  terminal,
  workspace,
  index,
  onIndexChange,
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
    useSwipePager({
      pageCount: 3,
      index,
      onIndexChange: handleIndexChange,
    });

  const translateX = -index * width + dragOffset;

  return (
    <div
      ref={shellRef}
      data-testid="app-spatial-shell"
      data-experience="app"
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
