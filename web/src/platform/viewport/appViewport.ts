/**
 * The App's single read/coordinate owner for browser viewport geometry (#3523).
 *
 * A soft keyboard changes the **visible** region, not the shell's layout box.
 * Before this module the App had no owner for that distinction: `Shell` was a
 * fixed `100dvh` frame, the capsule remeasured its own dock on
 * `visualViewport.resize`, and nothing could answer "is the focused control
 * still inside the visible rectangle?" without a second, competing read of the
 * browser's viewport.
 *
 * Three dimensions are deliberately separate and this module names all three:
 *
 * - `layoutBounds` — stable CSS layout geometry the shell/flex/grid consume;
 * - `visibleBounds` — the browser-visible rectangle translated into the same
 *   shell-local coordinate space (keyboard, browser toolbar, pan/zoom);
 * - `surfaceOcclusion` — floating internal UI overlap measured by the surface
 *   (`useCapsuleDockClearance`), **not** part of this module.
 *
 * A keyboard session is inferred from an editable focus **plus** reduced
 * visibility. A visual-viewport delta alone is never a `keyboardHeight` source
 * of truth: browser toolbars, zoom and page scroll can move the visible
 * rectangle without a keyboard, and those must not create an avoidance state.
 *
 * This file is framework-free: the DOM host lives in `AppViewportEnvironment`.
 */

export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface AppSafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface AppOccludedEdges {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface VisualViewportReading {
  offsetLeft: number;
  offsetTop: number;
  width: number;
  height: number;
  scale: number;
}

export type KeyboardSessionState = 'open' | 'closed';

export interface AppViewportSnapshot {
  /** Stable CSS layout box, in layout-viewport coordinates. */
  layoutBounds: ViewportRect;
  /** Browser-visible rectangle, shell-local and clipped to `layoutBounds`. */
  visibleBounds: ViewportRect;
  /** Effective safe-area insets (`env(safe-area-inset-*)` or a fixture input). */
  safeArea: AppSafeArea;
  /** How much of each layout edge the visible rectangle does not cover. */
  occludedEdges: AppOccludedEdges;
  /** Whether an editable element currently owns focus. */
  editableFocus: boolean;
  /** Actionable avoidance session: editable focus + a visible bottom inset. */
  keyboard: KeyboardSessionState;
  /** Monotonic counter over **meaningful** publishes only. */
  revision: number;
}

/** Marks the element that owns viewport reads for the App Experience. */
export const APP_VIEWPORT_ENVIRONMENT_ATTRIBUTE = 'data-app-viewport-environment';
/** Dispatched on that element after every meaningful snapshot. */
export const APP_VIEWPORT_SNAPSHOT_EVENT = 'nession:app-viewport-snapshot';

/** Marks the App Experience's keyboard-avoidance scroll ancestor. */
export const KEYBOARD_AVOIDANCE_SCROLLPORT_ATTRIBUTE = 'data-keyboard-avoidance-scrollport';
/** Set to `"true"` while the outer scrollport has a legal range to spend. */
export const KEYBOARD_AVOIDANCE_SCROLLABLE_ATTRIBUTE = 'data-keyboard-avoidance-scrollable';
/** Test/observability marker on a control that can be revealed. */
export const KEYBOARD_AVOIDANCE_TARGET_ATTRIBUTE = 'data-keyboard-avoidance-target';
/**
 * A caret target moved inside its control (the mobile IME textarea follows the
 * terminal cursor). The terminal runtime announces the movement; the scroll
 * owner decides what, if anything, to scroll.
 */
export const KEYBOARD_AVOIDANCE_TARGET_MOVED_EVENT = 'nession:keyboard-avoidance-target-moved';

/** Below this occlusion the visible rectangle has not meaningfully shrunk. */
export const KEYBOARD_MIN_OCCLUSION_PX = 1;
/**
 * How far above the visible bottom a revealed control is kept. Touch targets
 * need room for the finger; the exact value is an implementation comfort
 * margin, not a product measurement.
 */
export const KEYBOARD_REVEAL_MARGIN_PX = 16;

export const ZERO_SAFE_AREA: AppSafeArea = { top: 0, right: 0, bottom: 0, left: 0 };
export const ZERO_OCCLUDED_EDGES: AppOccludedEdges = { top: 0, right: 0, bottom: 0, left: 0 };

export function emptyViewportSnapshot(revision = 0): AppViewportSnapshot {
  return {
    layoutBounds: { left: 0, top: 0, width: 0, height: 0 },
    visibleBounds: { left: 0, top: 0, width: 0, height: 0 },
    safeArea: ZERO_SAFE_AREA,
    occludedEdges: ZERO_OCCLUDED_EDGES,
    editableFocus: false,
    keyboard: 'closed',
    revision,
  };
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function nonNegative(value: number): number {
  return Math.max(0, finite(value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface AppViewportInput {
  layoutBounds: ViewportRect;
  /** `null` means the browser did not expose `visualViewport`. */
  visualViewport: VisualViewportReading | null;
  safeArea?: AppSafeArea;
  editableFocus: boolean;
  revision: number;
}

/**
 * Build one snapshot from raw readings.
 *
 * Coordinate space: `layoutBounds` comes from `getBoundingClientRect()`; the
 * visual viewport is expressed in layout-viewport coordinates as
 * `offset + size * scale` (identical at scale 1), then translated into the
 * shell-local space by subtracting the layout origin. A missing or degenerate
 * visual viewport yields `visibleBounds === layoutBounds`, zero occlusion and
 * `keyboard: 'closed'`; absence is never interpreted as an open keyboard.
 */
export function computeAppViewportSnapshot(input: AppViewportInput): AppViewportSnapshot {
  const layout = {
    left: finite(input.layoutBounds.left),
    top: finite(input.layoutBounds.top),
    width: nonNegative(input.layoutBounds.width),
    height: nonNegative(input.layoutBounds.height),
  };
  const safeArea = input.safeArea ?? ZERO_SAFE_AREA;
  const visual = input.visualViewport;
  const hasVisual = visual !== null
    && finite(visual.width) > 0
    && finite(visual.height) > 0;
  if (!hasVisual) {
    return {
      layoutBounds: layout,
      visibleBounds: { ...layout },
      safeArea,
      occludedEdges: { ...ZERO_OCCLUDED_EDGES },
      editableFocus: input.editableFocus,
      keyboard: 'closed',
      revision: input.revision,
    };
  }

  const scale = Number.isFinite(visual.scale) && visual.scale > 0 ? visual.scale : 1;
  const left = finite(visual.offsetLeft) - layout.left;
  const top = finite(visual.offsetTop) - layout.top;
  const width = nonNegative(visual.width) * scale;
  const height = nonNegative(visual.height) * scale;
  const right = left + width;
  const bottom = top + height;

  const occludedEdges: AppOccludedEdges = {
    top: nonNegative(top),
    left: nonNegative(left),
    right: nonNegative(layout.width - right),
    bottom: nonNegative(layout.height - bottom),
  };
  const clippedLeft = clamp(left, 0, layout.width);
  const clippedTop = clamp(top, 0, layout.height);
  const clippedRight = clamp(right, 0, layout.width);
  const clippedBottom = clamp(bottom, 0, layout.height);

  return {
    layoutBounds: layout,
    visibleBounds: {
      left: clippedLeft,
      top: clippedTop,
      width: Math.max(0, clippedRight - clippedLeft),
      height: Math.max(0, clippedBottom - clippedTop),
    },
    safeArea,
    occludedEdges,
    editableFocus: input.editableFocus,
    keyboard: input.editableFocus && occludedEdges.bottom >= KEYBOARD_MIN_OCCLUSION_PX
      ? 'open'
      : 'closed',
    revision: input.revision,
  };
}

/**
 * Half-pixel quantization.
 *
 * Within one animation frame the browser can report sub-pixel jitter from
 * rounding, pan and toolbar animation. Publishing only on a half-pixel change
 * keeps those out of React-free observers and out of the geometry firewall,
 * while a real keyboard/metric change always clears the threshold.
 */
export function quantizePx(value: number): number {
  return Math.round(nonNegative(value) * 2) / 2;
}

function sameRect(a: ViewportRect, b: ViewportRect): boolean {
  return quantizePx(a.left) === quantizePx(b.left)
    && quantizePx(a.top) === quantizePx(b.top)
    && quantizePx(a.width) === quantizePx(b.width)
    && quantizePx(a.height) === quantizePx(b.height);
}

function sameEdges(a: AppOccludedEdges, b: AppOccludedEdges): boolean {
  return quantizePx(a.top) === quantizePx(b.top)
    && quantizePx(a.right) === quantizePx(b.right)
    && quantizePx(a.bottom) === quantizePx(b.bottom)
    && quantizePx(a.left) === quantizePx(b.left);
}

function sameSafeArea(a: AppSafeArea, b: AppSafeArea): boolean {
  return quantizePx(a.top) === quantizePx(b.top)
    && quantizePx(a.right) === quantizePx(b.right)
    && quantizePx(a.bottom) === quantizePx(b.bottom)
    && quantizePx(a.left) === quantizePx(b.left);
}

/** Whether two snapshots are the same meaningful state (ignoring revision). */
export function sameViewportSnapshot(a: AppViewportSnapshot, b: AppViewportSnapshot): boolean {
  return a.keyboard === b.keyboard
    && a.editableFocus === b.editableFocus
    && sameRect(a.layoutBounds, b.layoutBounds)
    && sameRect(a.visibleBounds, b.visibleBounds)
    && sameEdges(a.occludedEdges, b.occludedEdges)
    && sameSafeArea(a.safeArea, b.safeArea);
}

const EDITABLE_INPUT_TYPES = new Set([
  'text',
  'search',
  'url',
  'tel',
  'email',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'time',
  'week',
]);

/**
 * Whether an element is a focusable editable control.
 *
 * This is the "editable focus" half of keyboard inference: a button focus or a
 * terminal selection never opens an avoidance session, and a read-only field
 * does not summon a keyboard.
 */
export function isEditableElement(element: Element | null): boolean {
  if (element === null) {
    return false;
  }
  if (element instanceof HTMLTextAreaElement) {
    return !element.disabled && !element.readOnly;
  }
  if (element instanceof HTMLInputElement) {
    const type = element.type.toLowerCase();
    return !element.disabled && !element.readOnly
      && (type === '' || EDITABLE_INPUT_TYPES.has(type));
  }
  if (element instanceof HTMLElement) {
    // `isContentEditable` is not implemented by every DOM environment (jsdom
    // among them); the attribute is the same fact where the property is absent.
    if (element.isContentEditable) {
      return true;
    }
    const contentEditable = element.getAttribute('contenteditable');
    return contentEditable === ''
      || contentEditable === 'true'
      || contentEditable === 'plaintext-only';
  }
  return false;
}

/**
 * Publish one snapshot onto the environment element.
 *
 * DOM attributes and CSS variables are the observable contract: the Experience
 * scrollport and browser fixtures consume them without a React re-render, and
 * a visual-viewport change cannot leak into terminal geometry because nothing
 * in `terminal-runtime` subscribes to this element.
 */
const PUBLISHED_SNAPSHOTS = new WeakMap<Element, AppViewportSnapshot>();

export function publishAppViewportSnapshot(
  element: HTMLElement,
  snapshot: AppViewportSnapshot,
): void {
  PUBLISHED_SNAPSHOTS.set(element, snapshot);
  const style = element.style;
  style.setProperty('--nession-app-visible-top', `${quantizePx(snapshot.visibleBounds.top)}px`);
  style.setProperty('--nession-app-visible-left', `${quantizePx(snapshot.visibleBounds.left)}px`);
  style.setProperty('--nession-app-visible-bottom', `${quantizePx(
    snapshot.visibleBounds.top + snapshot.visibleBounds.height,
  )}px`);
  style.setProperty('--nession-app-visible-right', `${quantizePx(
    snapshot.visibleBounds.left + snapshot.visibleBounds.width,
  )}px`);
  style.setProperty('--nession-app-occlusion-bottom', `${quantizePx(
    snapshot.occludedEdges.bottom,
  )}px`);
  style.setProperty('--nession-app-safe-area-bottom', `${quantizePx(snapshot.safeArea.bottom)}px`);
  style.setProperty('--nession-app-safe-area-top', `${quantizePx(snapshot.safeArea.top)}px`);

  const dataset = element.dataset;
  dataset.appViewportRevision = String(snapshot.revision);
  dataset.appLayoutWidth = String(quantizePx(snapshot.layoutBounds.width));
  dataset.appLayoutHeight = String(quantizePx(snapshot.layoutBounds.height));
  dataset.appVisibleLeft = String(quantizePx(snapshot.visibleBounds.left));
  dataset.appVisibleTop = String(quantizePx(snapshot.visibleBounds.top));
  dataset.appVisibleWidth = String(quantizePx(snapshot.visibleBounds.width));
  dataset.appVisibleHeight = String(quantizePx(snapshot.visibleBounds.height));
  dataset.appOccludedTop = String(quantizePx(snapshot.occludedEdges.top));
  dataset.appOccludedRight = String(quantizePx(snapshot.occludedEdges.right));
  dataset.appOccludedBottom = String(quantizePx(snapshot.occludedEdges.bottom));
  dataset.appOccludedLeft = String(quantizePx(snapshot.occludedEdges.left));
  dataset.appSafeAreaTop = String(quantizePx(snapshot.safeArea.top));
  dataset.appSafeAreaRight = String(quantizePx(snapshot.safeArea.right));
  dataset.appSafeAreaBottom = String(quantizePx(snapshot.safeArea.bottom));
  dataset.appSafeAreaLeft = String(quantizePx(snapshot.safeArea.left));
  dataset.appEditableFocus = String(snapshot.editableFocus);
  dataset.appKeyboard = snapshot.keyboard;

  if (typeof CustomEvent === 'function') {
    element.dispatchEvent(new CustomEvent<AppViewportSnapshot>(APP_VIEWPORT_SNAPSHOT_EVENT, {
      detail: snapshot,
    }));
  }
}

/** The last snapshot published on an environment element, if any. */
export function readPublishedAppViewport(element: Element | null): AppViewportSnapshot | null {
  return element === null ? null : PUBLISHED_SNAPSHOTS.get(element) ?? null;
}

/** The nearest App viewport environment ancestor. */
export function findAppViewportEnvironment(element: Element | null): HTMLElement | null {
  const found = element?.closest(`[${APP_VIEWPORT_ENVIRONMENT_ATTRIBUTE}]`);
  return found instanceof HTMLElement ? found : null;
}
