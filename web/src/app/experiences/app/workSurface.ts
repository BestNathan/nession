/**
 * Where top-level App navigation is allowed to start.
 *
 * The Sessions ← Terminal → Workspace swipe is a *shell* gesture, so it must
 * not begin inside a surface that already owns touch behaviour: a page that
 * started there would consume the first horizontal pixels of a text selection,
 * a scrollback drag, or an editor gesture before the surface ever saw them.
 *
 * This is #1049's decision 1 — **work-surface exclusion** — and it still owns
 * the interior of every surface. It is no longer the whole rule. #1081 found
 * that on the Terminal screen, where the viewport and the capsule *are* the
 * screen, exclusion alone left the gesture with almost nowhere to start, and
 * re-admitted the shell's own edges as a bounded exception (`edgeBand.ts`).
 *
 * Read the two together: this module says a work surface owns the touches that
 * begin in it, and that one says the shell may still claim one within
 * `EDGE_BAND_PX` of its own edge — and only in the direction that edge's layer
 * arrives from. The middle of a surface is unaffected.
 *
 * The list names what is **excluded**; it is not a whitelist. A start that
 * cannot be classified — no target, or a target outside any element — is
 * therefore allowed. That is deliberate: the rule is "do not steal from the
 * work", not "only these places may navigate".
 */
export const WORK_SURFACE_SELECTOR = [
  // The terminal well's xterm mount box (`TerminalViewport`), and xterm's own
  // root as well, so a selection or a mouse-reporting TUI stays xterm's even
  // if a future mount point is not the one `TerminalViewport` builds.
  '[data-terminal-viewport]',
  '.xterm',
  // CodeMirror, the Files editor: it selects text and scrolls both axes.
  '.cm-editor',
  // IME and typeahead fields — including xterm's own helper `textarea`, which
  // is where a mobile IME actually lands while the terminal has focus.
  'textarea',
  // The capsule composer, which owns its own drag, IME, and keyboard gestures.
  '[data-testid="terminal-capsule"]',
  // The capability capsule's row, which is a horizontal scroller: its entries
  // are wider than a phone, so it pans by touch. A shell page claimed there
  // would spend the row's first horizontal pixels and move the surface at the
  // same time — measured on the Workspace root 2026-10-03, the row scrolled
  // *and* the pager paged. #2724 makes the row a full owner: a nested
  // horizontal scroller keeps its touch even at the shell edge, because
  // claiming there would still spend the first pixels of its own pan.
  '[data-testid="workspace-capability-capsule"]',
].join(', ');

/**
 * Elements that own a touch unconditionally (#2724).
 *
 * These are not work surfaces that may yield a bounded edge band: a control,
 * a text field, an open panel or a pushed detail is the surface's own
 * interaction, and a shell swipe that began on one would compete with the
 * action the user aimed at. The distinction matters at the edge: #1081's band
 * may re-admit the *interior* of an xterm or editor, but it must not claim a
 * button, a composer field, an open Peek or a horizontal row simply because
 * the touch is near an edge. The prototype that shaped this rule filtered the
 * same set before it ever looked at the band.
 *
 * `[data-swipe-owner]` is the explicit escape hatch for a future surface that
 * owns a gesture without having a semantic role or test id.
 */
export const INTERACTIVE_OWNER_SELECTOR = [
  'button',
  'input',
  'select',
  'textarea',
  'a[href]',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  // The expanded Capsule Peek: a capability preview with its own controls and
  // scroll region, not chrome the shell may page from.
  '[data-testid="capsule-capability-projection"]',
  // The capability row is a nested horizontal scroller and therefore fully
  // owns its drags (see the note in `WORK_SURFACE_SELECTOR`).
  '[data-testid="workspace-capability-capsule"]',
  '[data-swipe-owner]',
].join(', ');

/**
 * Whether `target` is an interactive owner that always keeps its touch.
 *
 * Checked before the work-surface rule: an element can be both (a textarea is
 * a work surface *and* an input), and the stricter owner wins.
 */
export function isInteractiveOwner(target: EventTarget | null): boolean {
  const element = asElement(target);
  return element !== null && element.closest(INTERACTIVE_OWNER_SELECTOR) !== null;
}

/**
 * Whether a native text selection is active on or around `target` (#2724).
 *
 * A selection is the surface's own interaction: a shell page that began in it
 * would steal the drag that extends or collapses it. The check is limited to
 * the touched target's own subtree so a selection elsewhere on the page does
 * not disable navigation.
 */
export function hasActiveSelectionWithin(target: EventTarget | null): boolean {
  if (typeof document === 'undefined' || typeof document.getSelection !== 'function') {
    return false;
  }
  const selection = document.getSelection();
  const node = selection?.anchorNode ?? null;
  const element = asElement(target);
  if (selection === null || selection.isCollapsed || node === null || element === null) {
    return false;
  }
  if (element.contains(node)) {
    return true;
  }
  const anchorElement = node instanceof Element ? node : node.parentElement;
  return anchorElement !== null && anchorElement.contains(element);
}

/**
 * Whether a touch that started on `target` belongs to a work surface rather
 * than to shell navigation.
 *
 * `target` is `EventTarget | null` because that is what a React synthetic
 * event hands out; a target that is neither an element nor a node (or is
 * missing) is not a work surface, per the module's exclusion rule.
 */
export function isWorkSurface(target: EventTarget | null): boolean {
  const element = asElement(target);
  return element !== null && element.closest(WORK_SURFACE_SELECTOR) !== null;
}

function asElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) {
    return target;
  }
  // A text node is a legitimate touch target; the element around it is what
  // the selector can speak about.
  if (target instanceof Node) {
    return target.parentElement;
  }
  return null;
}
