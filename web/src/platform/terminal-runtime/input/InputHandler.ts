// web/src/terminal/input/InputHandler.ts
import type { InputMode } from '../types';

/** Handles user input for a single input mode. */
export interface InputHandler {
  readonly mode: InputMode['type'];
  handle(data: string): void;
  activate(): void;
  deactivate(): void;
}
