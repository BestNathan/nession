// web/src/terminal/input/InputRouter.ts
import type { InputMode } from '../state/input';
import type { InputHandler } from './InputHandler';

/** Routes user input to the handler for the currently active input mode. */
export class InputRouter {
  private handlers = new Map<InputMode['type'], InputHandler>();
  private currentMode: InputMode['type'] = 'terminal';

  register(handler: InputHandler): void {
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
