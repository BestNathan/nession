import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppPopupPortal } from './AppPopupPortal';
import {
  indexFromLayer,
  layerFromIndex,
  layerGeometry,
  type AppLayer,
} from './appLayerPositions';
import type { ShellBounds } from './edgeBand';
import { useSwipePager } from './useSwipePager';

const FALLBACK_WIDTH_PX = 375;

export type { AppLayer };

export interface AppLayersProps {
  layer: AppLayer;
  onLayerChange: (layer: AppLayer) => void;
  sessions: ReactNode;
  terminal: ReactNode;
  /**
   * The Workspace layer, or `null` when there is nothing for it to show (#1082:
   * Workspace is Session-scoped, so it does not exist before a Session does).
   *
   * `null` is not an empty node. It removes the layer from the pager as well as
   * from the DOM, which is what stops a leftward drag from pulling an empty
   * depth over the home — the alternative, rendering an empty Workspace, would
   * answer the gesture with a blank screen.
   */
  workspace: ReactNode | null;
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

  // The edge band is measured from this element, not from the window (#1081):
  // the App is routinely narrower than the viewport — 390px inside a desktop
  // browser, and inside the fixture the browser contract suite drives — and a
  // band taken from `window.innerWidth` would sit off-screen there, leaving the
  // gesture unreachable in exactly the case a test can see. Read per touch
  // rather than cached, so it stays right through a resize or a scroll.
  const getShellBounds = useCallback((): ShellBounds | null => {
    const el = rootRef.current;
    if (!el) {
      return null;
    }
    const rect = el.getBoundingClientRect();
    return { left: rect.left, right: rect.right };
  }, []);

  const { dragOffset, onTouchStart, onTouchMove, onTouchEnd, onTouchCancel } =
    useSwipePager({
      // Two positions before a Session exists, three after (#1082). The pager
      // already refuses to commit past `pageCount`, so this is what makes the
      // leftward drag a no-op rather than a page onto nothing.
      pageCount: workspace === null ? 2 : 3,
      index: indexFromLayer(layer),
      onIndexChange: handleIndexChange,
      getShellBounds,
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
      {/* Every layer is inside the App's popup container, so a menu opened from
          any of them is mounted into a node that states `data-experience="app"`
          — the scope this element opens, which a popup on `<body>` would
          otherwise leave (#1066). */}
      <AppPopupPortal>
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

        {workspace !== null && showWorkspace && (
          <div
            data-testid="app-layer-workspace"
            className="absolute inset-0 z-40 overflow-hidden will-change-transform"
            style={{ transform: `translateX(${workspaceX}px)` }}
          >
            {workspace}
          </div>
        )}
      </AppPopupPortal>
    </div>
  );
}
