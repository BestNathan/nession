import { describe, expect, it } from 'vitest';
import {
  indexFromLayer,
  layerFromIndex,
  layerGeometry,
  type AppLayer,
} from '../../appLayerPositions';

const WIDTH = 400;

describe('appLayerPositions — layer/index mapping', () => {
  it('round-trips every layer through its pager index', () => {
    const layers: AppLayer[] = ['sessions', 'terminal', 'workspace'];
    for (const layer of layers) {
      expect(layerFromIndex(indexFromLayer(layer))).toBe(layer);
    }
  });

  it('orders the indices as the product model does', () => {
    // Sessions ← Terminal → Workspace. If these drift, a swipe reveals the
    // wrong side, which is the one failure the geometry maths cannot catch.
    expect(indexFromLayer('sessions')).toBe(0);
    expect(indexFromLayer('terminal')).toBe(1);
    expect(indexFromLayer('workspace')).toBe(2);
  });

  it('clamps an index outside the pager range to the nearest layer', () => {
    expect(layerFromIndex(-5)).toBe('sessions');
    expect(layerFromIndex(99)).toBe('workspace');
  });
});

describe('appLayerPositions — resting geometry', () => {
  it('shows neither layer while Terminal is at rest', () => {
    const geometry = layerGeometry('terminal', 0, WIDTH);
    expect(geometry.showSessions).toBe(false);
    expect(geometry.showWorkspace).toBe(false);
  });

  it('parks a closed layer exactly one width off-screen', () => {
    const geometry = layerGeometry('terminal', 0, WIDTH);
    // Exactly off-screen: one pixel less and the closed layer would be
    // partially painted over the terminal.
    expect(geometry.sessionsX).toBe(-WIDTH);
    expect(geometry.workspaceX).toBe(WIDTH);
  });

  it('puts an open layer at rest at zero', () => {
    expect(layerGeometry('sessions', 0, WIDTH).sessionsX).toBe(0);
    expect(layerGeometry('workspace', 0, WIDTH).workspaceX).toBe(0);
  });
});

describe('appLayerPositions — dragging', () => {
  it('previews Sessions progressively while dragging right from Terminal', () => {
    const geometry = layerGeometry('terminal', 120, WIDTH);
    // -400 + 120: on screen, and not yet fully open.
    expect(geometry.sessionsX).toBe(-280);
    expect(geometry.showSessions).toBe(true);
    expect(geometry.showWorkspace).toBe(false);
  });

  it('previews Workspace progressively while dragging left from Terminal', () => {
    const geometry = layerGeometry('terminal', -120, WIDTH);
    expect(geometry.workspaceX).toBe(280);
    expect(geometry.showWorkspace).toBe(true);
    expect(geometry.showSessions).toBe(false);
  });

  it('tracks the finger while an open layer is being dismissed', () => {
    // Sessions is open and the drag is pulling it back out to the left.
    const geometry = layerGeometry('sessions', -90, WIDTH);
    expect(geometry.sessionsX).toBe(-90);
    expect(geometry.showSessions).toBe(true);
  });

  it('does not let a drag past the edge push a layer through the boundary', () => {
    // Over-dragging right with Sessions already open must not move it past 0.
    expect(layerGeometry('sessions', 250, WIDTH).sessionsX).toBe(0);
    // Over-dragging left from Terminal must not pull Sessions in from beyond
    // one width — that would leave a gap the terminal shows through.
    expect(layerGeometry('terminal', -250, WIDTH).sessionsX).toBe(-WIDTH);
    expect(layerGeometry('terminal', -250, WIDTH).showSessions).toBe(false);
  });

  it('keeps the two layers independent while one of them is open', () => {
    // Opening Sessions must not also bring Workspace into view, and vice
    // versa — they are siblings over the same root, not a track.
    const sessions = layerGeometry('sessions', 0, WIDTH);
    expect(sessions.showSessions).toBe(true);
    expect(sessions.sessionsX).toBe(0);
    expect(sessions.showWorkspace).toBe(false);

    const workspace = layerGeometry('workspace', 0, WIDTH);
    expect(workspace.showWorkspace).toBe(true);
    expect(workspace.workspaceX).toBe(0);
    expect(workspace.showSessions).toBe(false);
  });

  it('leaves the opposite layer parked when a drag is cancelled', () => {
    // A drag released below the commit threshold resets the offset to 0. An
    // open layer must stay open at rest, and the other must stay off-screen
    // rather than remaining painted at the edge.
    const geometry = layerGeometry('sessions', 0, WIDTH);
    expect(geometry.sessionsX).toBe(0);
    expect(geometry.showWorkspace).toBe(false);
  });
});
