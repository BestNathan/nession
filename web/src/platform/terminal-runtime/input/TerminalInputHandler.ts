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

  /**
   * Idempotent: a second activate releases the previous subscription first.
   *
   * Without this, `activate()` overwrote `unsub` and the earlier subscription
   * became unreachable — nothing held a reference to dispose it, so it stayed
   * live for the life of the terminal and every `onData` emission reached the
   * PTY once per leaked subscription (#1096).
   */
  activate(): void {
    this.unsub?.();
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
