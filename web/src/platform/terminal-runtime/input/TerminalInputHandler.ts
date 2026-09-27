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
   * Idempotent: a second activate disposes the previous subscription first.
   *
   * Without this, `activate()` overwrote `unsub` and the first subscription
   * became unreachable — nothing held a reference to dispose it, so it stayed
   * live for the life of the terminal. Every `terminal.onData` emission then
   * went to the PTY once per leaked subscription, which is #1148: typed
   * characters arrived interleaved (`eecchhoo`) and terminal query responses
   * (DA1/DA2, OSC 10/11) were doubled too — the latter proving two live
   * subscriptions, since responses have only `onData` as a source.
   *
   * `bindXtermOnData`'s doc already claimed idempotence per controller
   * instance. This is what makes that true rather than aspirational.
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
