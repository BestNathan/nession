// web/src/terminal/input/CustomInputHandler.ts
import type { InputHandler } from './InputHandler';

/** Custom / plugin input mode (wired in a later task). */
export class CustomInputHandler implements InputHandler {
  readonly mode = 'custom' as const;

  handle(data: string): void {
    void data;
  }

  activate(): void {}

  deactivate(): void {}
}
