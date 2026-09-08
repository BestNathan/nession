// web/src/terminal/input/TerminalInputHandler.ts
import type { TerminalTransport } from '../transport/TerminalTransport';
import type { InputHandler } from './InputHandler';

/**
 * Terminal mode: forwards xterm keyboard input straight to the transport.
 * Ctrl+D (EOT, `\x04`) is intercepted and routed to `onCtrlD` instead of
 * reaching the PTY so the UI can decide how to handle session close.
 */
export class TerminalInputHandler implements InputHandler {
  readonly mode = 'terminal' as const;
  private unsub: (() => void) | null = null;
  onCtrlD: (() => void) | null = null;

  constructor(
    private transport: TerminalTransport,
    private xtermOnData: (cb: (data: string) => void) => () => void,
  ) {}

  activate(): void {
    this.unsub = this.xtermOnData((data: string) => {
      if (data === '\x04') {
        this.onCtrlD?.();
        return;
      }
      this.transport.send(data);
    });
  }

  deactivate(): void {
    this.unsub?.();
    this.unsub = null;
  }

  handle(data: string): void {
    this.transport.send(data);
  }
}
