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
].join(', ');

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
