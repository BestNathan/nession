// web/src/terminal/input/InputRouter.ts
import type { InputMode } from '../types';
import type { InputHandler } from './InputHandler';

/** Routes user input to the handler for the currently active input mode. */
export class InputRouter {
  private handlers = new Map<InputMode['type'], InputHandler>();
  private currentMode: InputMode['type'] = 'terminal';

  /**
   * Register (or replace) the handler for its mode, deactivating whatever it
   * replaces — `TerminalController.wireTerminalUi` re-registers on a viewport
   * reparent and reuses the same router, so nothing else deactivates the
   * previous handler and its `terminal.onData` subscription would stay live.
   */
  register(handler: InputHandler): void {
    this.handlers.get(handler.mode)?.deactivate();
    this.handlers.set(handler.mode, handler);
  }

  /**
   * Deactivate the current handler, leaving no replacement active.
   *
   * Distinct from `setMode`, which deactivates the current handler and then
   * **activates the one for the requested mode**. `detach()` used `setMode({
   * type: 'terminal' })` to mean "deactivate", but the requested mode is the
   * active one, so it deactivated and immediately re-activated — leaving the
   * handler subscribed while the router was dropped. Every detach/attach cycle
   * therefore leaked a live `terminal.onData` subscription, and #1148's
   * diagnostic caught three of them stacked on one terminal.
   */
  deactivateCurrent(): void {
    this.handlers.get(this.currentMode)?.deactivate();
  }

  /** Deactivate the current handler, then activate the one for `mode`. */
  setMode(mode: InputMode): void {
    this.handlers.get(this.currentMode)?.deactivate();
    this.currentMode = mode.type;
    this.handlers.get(this.currentMode)?.activate();
  }

  getMode(): InputMode {
    return { type: this.currentMode } as InputMode;
  }

  /** Dispatch user input to the active handler. */
  route(data: string): void {
    this.handlers.get(this.currentMode)?.handle(data);
  }
}
