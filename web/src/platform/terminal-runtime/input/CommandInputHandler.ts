// web/src/terminal/input/CommandInputHandler.ts
import type { InputHandler } from './InputHandler';

/** Command palette input mode (wired in a later task). */
export class CommandInputHandler implements InputHandler {
  readonly mode = 'command' as const;

  handle(data: string): void {
    void data;
  }

  activate(): void {}

  deactivate(): void {}
}
