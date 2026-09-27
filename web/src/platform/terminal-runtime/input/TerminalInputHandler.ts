import type { TerminalInteractionController } from '../interaction/TerminalInteractionController';
import type { InputHandler } from './InputHandler';

/**
 * Terminal mode: xterm keyboard → shared interaction layer → PTY.
 * Standard control bytes (including Ctrl+D / EOT) are never hijacked (#1096).
 */
export class TerminalInputHandler implements InputHandler {
  readonly mode = 'terminal' as const;
  private unsub: (() => void) | null = null;

  constructor(private interaction: TerminalInteractionController) {}

  activate(): void {
    this.unsub = this.interaction.bindXtermOnData();
  }

  deactivate(): void {
    this.unsub?.();
    this.unsub = null;
  }

  handle(data: string): void {
    this.interaction.sendPtyBytes(data);
  }
}
