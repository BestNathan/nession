// web/src/terminal/input/AIInputHandler.ts
import type { InputHandler } from './InputHandler';

/** AI assistant input mode (wired in a later task). */
export class AIInputHandler implements InputHandler {
  readonly mode = 'ai' as const;

  handle(data: string): void {
    void data;
  }

  activate(): void {}

  deactivate(): void {}
}
