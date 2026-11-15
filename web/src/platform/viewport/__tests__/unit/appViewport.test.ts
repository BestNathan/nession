import { describe, expect, it } from 'vitest';
import {
  computeAppViewportSnapshot,
  emptyViewportSnapshot,
  quantizePx,
  sameViewportSnapshot,
  type AppViewportSnapshot,
  type ViewportRect,
} from '@/platform/viewport/appViewport';

const LAYOUT: ViewportRect = { left: 0, top: 0, width: 390, height: 844 };

function snapshot(overrides: Partial<Parameters<typeof computeAppViewportSnapshot>[0]> = {}): AppViewportSnapshot {
  return computeAppViewportSnapshot({
    layoutBounds: LAYOUT,
    visualViewport: { offsetLeft: 0, offsetTop: 0, width: 390, height: 544, scale: 1 },
    editableFocus: true,
    revision: 1,
    ...overrides,
  });
}

describe('computeAppViewportSnapshot', () => {
  it('derives an actionable keyboard session from editable focus plus reduced visibility', () => {
    const state = snapshot();
    expect(state.layoutBounds).toEqual(LAYOUT);
    expect(state.visibleBounds).toEqual({ left: 0, top: 0, width: 390, height: 544 });
    expect(state.occludedEdges).toEqual({ top: 0, right: 0, bottom: 300, left: 0 });
    expect(state.keyboard).toBe('open');
    expect(state.editableFocus).toBe(true);
  });

  it('tracks visual bounds without inventing a keyboard when nothing editable is focused', () => {
    const state = snapshot({ editableFocus: false, visualViewport: { offsetLeft: 0, offsetTop: 0, width: 390, height: 760, scale: 1 } });
    expect(state.visibleBounds.height, 'a browser toolbar still moves the visible rectangle').toBe(760);
    expect(state.occludedEdges.bottom).toBe(84);
    expect(state.keyboard, 'no focus means no avoidance session').toBe('closed');
  });

  it('does not turn a missing visualViewport API into a keyboard or a scroll reserve', () => {
    const state = snapshot({ visualViewport: null });
    expect(state.visibleBounds).toEqual(LAYOUT);
    expect(state.occludedEdges).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(state.keyboard).toBe('closed');
  });

  it('treats a degenerate visual viewport as unavailable rather than zero-height', () => {
    const state = snapshot({ visualViewport: { offsetLeft: 0, offsetTop: 0, width: 0, height: 0, scale: 1 } });
    expect(state.visibleBounds).toEqual(LAYOUT);
    expect(state.keyboard).toBe('closed');
  });

  it('translates both rectangles into the same shell-local space', () => {
    const state = snapshot({
      layoutBounds: { left: 20, top: 60, width: 390, height: 780 },
      visualViewport: { offsetLeft: 20, offsetTop: 60, width: 390, height: 480, scale: 1 },
    });
    expect(state.visibleBounds).toEqual({ left: 0, top: 0, width: 390, height: 480 });
    expect(state.occludedEdges.bottom).toBe(300);
  });

  it('clips a visible rectangle that also exposes area above/left of the shell', () => {
    const state = snapshot({
      layoutBounds: { left: 20, top: 60, width: 390, height: 780 },
      visualViewport: { offsetLeft: 10, offsetTop: 40, width: 390, height: 500, scale: 1 },
    });
    expect(state.visibleBounds).toEqual({ left: 0, top: 0, width: 380, height: 480 });
    expect(state.occludedEdges.left).toBe(0);
    expect(state.occludedEdges.top).toBe(0);
    expect(state.occludedEdges.right).toBe(10);
    expect(state.occludedEdges.bottom).toBe(300);
  });

  it('converts visual pixels to layout pixels at pinch scale', () => {
    const state = snapshot({
      visualViewport: { offsetLeft: 0, offsetTop: 0, width: 195, height: 272, scale: 2 },
    });
    expect(state.visibleBounds.height).toBe(544);
    expect(state.occludedEdges.bottom).toBe(300);
  });
});

describe('snapshot identity', () => {
  it('ignores sub-half-pixel jitter and revision changes', () => {
    const a = snapshot({ revision: 2 });
    const b = snapshot({ revision: 3, visualViewport: { offsetLeft: 0, offsetTop: 0, width: 390, height: 543.8, scale: 1 } });
    expect(sameViewportSnapshot(a, b)).toBe(true);
  });

  it('publishes a one-pixel change and a keyboard transition', () => {
    const a = snapshot();
    const onePixel = snapshot({ visualViewport: { offsetLeft: 0, offsetTop: 0, width: 390, height: 543, scale: 1 } });
    expect(sameViewportSnapshot(a, onePixel)).toBe(false);
    const closed = emptyViewportSnapshot(9);
    expect(sameViewportSnapshot(a, closed)).toBe(false);
  });

  it('quantizes to half pixels', () => {
    expect(quantizePx(10.24)).toBe(10);
    expect(quantizePx(10.26)).toBe(10.5);
    expect(quantizePx(-4)).toBe(0);
  });
});
