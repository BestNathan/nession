/**
 * Geometry for the App's Terminal-root layer model (#1049).
 *
 * Terminal is the root and is always mounted. Sessions and Workspace are
 * layers that slide over it, so their position is a pure function of the
 * active layer, the live drag offset, and the shell width. Keeping it here
 * rather than inline in the component means the gesture maths is testable
 * without a DOM, which is the part most likely to be wrong.
 *
 * Layer order matches the product model `Sessions ← Terminal → Workspace`:
 * dragging right reveals Sessions (index 0), dragging left reveals Workspace
 * (index 2). Terminal is the resting state at index 1.
 */

export type AppLayer = 'sessions' | 'terminal' | 'workspace';

/** Pager slot per layer. The indices are the product model's own order. */
const LAYER_INDEX: Record<AppLayer, number> = {
  sessions: 0,
  terminal: 1,
  workspace: 2,
};

/** Inverse of {@link LAYER_INDEX}; index 1 is the root, never a layer. */
export function layerFromIndex(index: number): AppLayer {
  if (index <= 0) {
    return 'sessions';
  }
  return index >= 2 ? 'workspace' : 'terminal';
}

export function indexFromLayer(layer: AppLayer): number {
  return LAYER_INDEX[layer];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface LayerGeometry {
  sessionsX: number;
  workspaceX: number;
  showSessions: boolean;
  showWorkspace: boolean;
}

/**
 * Where each layer sits during a drag.
 *
 * An open layer tracks the finger. A closed layer is parked exactly one width
 * off-screen, so a drag toward it moves it into view progressively rather than
 * appearing at the moment the gesture commits — that preview is what makes the
 * gesture legible while it is still cancellable.
 *
 * Visibility is deliberately derived from the resulting position rather than
 * from the drag offset sign: a layer that is exactly off-screen is not
 * rendered, and the arithmetic already encodes that.
 */
export function layerGeometry(
  layer: AppLayer,
  dragOffset: number,
  width: number,
): LayerGeometry {
  const sessionsX = clamp(
    layer === 'sessions' ? dragOffset : -width + dragOffset,
    -width,
    0,
  );
  const workspaceX = clamp(
    layer === 'workspace' ? dragOffset : width + dragOffset,
    0,
    width,
  );

  return {
    sessionsX,
    workspaceX,
    showSessions: sessionsX > -width,
    showWorkspace: workspaceX < width,
  };
}
