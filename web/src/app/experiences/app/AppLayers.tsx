import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  indexFromLayer,
  layerFromIndex,
  layerGeometry,
  type AppLayer,
} from './appLayerPositions';
import { useSwipePager } from './useSwipePager';

const FALLBACK_WIDTH_PX = 375;

export type { AppLayer };

export interface AppLayersProps {
  layer: AppLayer;
  onLayerChange: (layer: AppLayer) => void;
  sessions: ReactNode;
  terminal: ReactNode;
  workspace: ReactNode;
}

/**
 * The App's navigation composition (#1049).
 *
 * Terminal is the root work surface and stays mounted for the whole life of a
 * selected Session — opening Sessions or Workspace slides a layer over it
 * rather than moving the Terminal off-screen, so xterm, the attach state and
 * the scrollback are never rebuilt by a navigation event. That is the
 * acceptance criterion this shape exists to satisfy.
 *
 * This replaced three permanently translated pages. The gestures are unchanged:
 * `useSwipePager` still owns the commit threshold and the axis lock, and its
 * work-surface start gate (#1049 stage 1) applies here exactly as it did.
 */
export function AppLayers({
  layer,
  onLayerChange,
  sessions,
  terminal,
  workspace,
}: AppLayersProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH_PX);

  useEffect(() => {
    const el = rootRef.current;
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
      onLayerChange(layerFromIndex(next));
    },
    [onLayerChange],
  );

  const { dragOffset, onTouchStart, onTouchMove, onTouchEnd, onTouchCancel } =
    useSwipePager({
      pageCount: 3,
      index: indexFromLayer(layer),
      onIndexChange: handleIndexChange,
    });

  const { sessionsX, workspaceX, showSessions, showWorkspace } =
    layerGeometry(layer, dragOffset, width);

  return (
    <div
      ref={rootRef}
      data-testid="app-layer-root"
      data-experience="app"
      data-layer={layer}
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
    >
      <div
        data-testid="app-layer-terminal"
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        {terminal}
      </div>

      {showSessions && (
        <div
          data-testid="app-layer-sessions"
          className="absolute inset-0 z-40 overflow-hidden will-change-transform"
          style={{ transform: `translateX(${sessionsX}px)` }}
        >
          {sessions}
        </div>
      )}

      {showWorkspace && (
        <div
          data-testid="app-layer-workspace"
          className="absolute inset-0 z-40 overflow-hidden will-change-transform"
          style={{ transform: `translateX(${workspaceX}px)` }}
        >
          {workspace}
        </div>
      )}
    </div>
  );
}
