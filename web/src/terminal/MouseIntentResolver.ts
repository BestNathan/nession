import type { Terminal } from '@xterm/xterm';

/**
 * Routes mouse events to the PTY or to local selection based on context.
 *
 * ## Option B: tmux-native selection
 *
 * Instead of manually injecting SGR sequences, this class overrides
 * xterm.js's `shouldForceSelection` gate so that:
 *
 *   - Single click / drag (mouse active, no Shift) → xterm generates SGR
 *     sequences naturally → tmux receives them → tmux enters copy mode for
 *     drags (screen frozen, selection stable) or forwards clicks to the
 *     TUI application.
 *
 *   - Double / triple click → local word / line selection in the browser.
 *
 *   - Shift + click / drag → always local browser selection.
 *
 *   - Mouse mode inactive → all events stay local.
 *
 * No manual SGR injection, no DOM listeners, no state machine.  xterm.js
 * handles all the heavy lifting; this class just tells it *when* to send
 * events to the PTY vs keep them local.
 *
 * ## Tmux copy-mode selection
 *
 * With `set -g mouse on` (set by the agent at session creation), tmux
 * enters copy mode on drag gestures when the inner application hasn't
 * enabled its own mouse tracking.  Copy mode freezes the screen, so the
 * selection highlight is never wiped by TUI redraws.
 */

/** Shape of the internal core-mouse service we read for the active gate. */
interface CoreMouseService {
  areMouseEventsActive: boolean;
  activeEncoding: string;
}

export class MouseIntentResolver {
  private disposed = false;

  /** Original `shouldForceSelection` — restored on dispose. */
  private origShouldForceSelection:
    | ((e: MouseEvent) => boolean)
    | null = null;

  constructor(private terminal: Terminal) {
    this.install();
  }

  // ── Install / remove ──────────────────────────────────────────────

  private install(): void {
    const core = (this.terminal as unknown as Record<string, unknown>)
      ._core as Record<string, unknown> | undefined;
    const sel = core?._selectionService as
      | { shouldForceSelection: (e: MouseEvent) => boolean }
      | undefined;
    if (!sel) { return; }

    this.origShouldForceSelection = sel.shouldForceSelection.bind(sel);

    sel.shouldForceSelection = (e: MouseEvent): boolean => {
      // Shift always forces local selection (standard terminal convention).
      if (e.shiftKey) { return true; }

      // When the TUI hasn't enabled mouse tracking, keep everything local.
      if (!this.isMouseActive()) { return true; }

      // Double / triple click → let the browser handle word / line
      // selection natively.  event.detail is the click count.
      if (e.detail > 1) { return true; }

      // Single click, mouse mode active → let xterm generate SGR so the
      // event reaches tmux (clicks forwarded to the TUI, drags enter
      // tmux copy mode for stable selection).
      return false;
    };
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;

    // Restore xterm's original selection behaviour.
    if (this.origShouldForceSelection) {
      const core = (this.terminal as unknown as Record<string, unknown>)
        ._core as Record<string, unknown> | undefined;
      const sel = core?._selectionService as
        | { shouldForceSelection: (e: MouseEvent) => boolean }
        | undefined;
      if (sel) {
        sel.shouldForceSelection = this.origShouldForceSelection;
      }
    }
  }

  // ── Mouse-active gate ─────────────────────────────────────────────

  /**
   * Returns true when the TUI has enabled SGR mouse tracking, meaning it
   * wants to receive mouse events.  Reads xterm's internal
   * `coreMouseService` which mirrors the application's DECSET sequences.
   */
  private isMouseActive(): boolean {
    const core = (this.terminal as unknown as Record<string, unknown>)
      ._core as Record<string, unknown> | undefined;
    const ms = core?.coreMouseService as CoreMouseService | undefined;
    if (ms) {
      return ms.areMouseEventsActive && ms.activeEncoding === 'SGR';
    }
    // Fallback: check the CSS class xterm toggles on enable.
    return this.terminal.element?.classList.contains('enable-mouse-events') ?? false;
  }
}
