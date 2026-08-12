// web/src/terminal/input/SearchInputHandler.ts
import type { InputHandler } from './InputHandler';

/** Search / find input mode (wired in a later task). */
export class SearchInputHandler implements InputHandler {
  readonly mode = 'search' as const;

  handle(data: string): void {
    void data;
  }

  activate(): void {}

  deactivate(): void {}
}
