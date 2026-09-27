// web/src/terminal/input/InputRouter.ts
import type { InputMode } from '../types';
import type { InputHandler } from './InputHandler';

/** Routes user input to the handler for the currently active input mode. */
export class InputRouter {
  private handlers = new Map<InputMode['type'], InputHandler>();
  private currentMode: InputMode['type'] = 'terminal';

  /**
   * Register (or replace) the handler for its mode, deactivating whatever it
   * replaces.
   *
   * `setMode` deactivates on the way out, but `register` is also called
   * directly — `TerminalController` re-registers the terminal handler when the
   * viewport reparents, and it **reuses the same router**, so nothing else
   * deactivates the previous one. The replaced handler was then orphaned with a
   * live `terminal.onData` subscription, and every emission was written to the
   * PTY twice (#1148): typed characters *and* terminal responses, the latter
   * being what proved it was two subscriptions rather than a second keyboard
   * path, since responses have only that one source.
   *
   * Enforced here rather than at the call site so no future caller can
   * reintroduce it by forgetting.
   */
  register(handler: InputHandler): void {
    this.handlers.get(handler.mode)?.deactivate();
    this.handlers.set(handler.mode, handler);
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
