// web/src/terminal/input/__tests__/stubHandlers.test.ts
import { describe, it, expect } from 'vitest';
import { AIInputHandler } from '@/terminal/input/AIInputHandler';
import { CommandInputHandler } from '@/terminal/input/CommandInputHandler';
import { CustomInputHandler } from '@/terminal/input/CustomInputHandler';
import { SearchInputHandler } from '@/terminal/input/SearchInputHandler';

/** Drive a handler through its full lifecycle; must never throw. */
function exercise(handler: {
  activate: () => void;
  handle: (data: string) => void;
  deactivate: () => void;
}): void {
  handler.activate();
  handler.handle('x');
  handler.deactivate();
}

describe('stub input handlers (no-op placeholders)', () => {
  it('AIInputHandler is a no-op with mode ai', () => {
    const handler = new AIInputHandler();
    expect(handler.mode).toBe('ai');
    expect(() => exercise(handler)).not.toThrow();
  });

  it('CommandInputHandler is a no-op with mode command', () => {
    const handler = new CommandInputHandler();
    expect(handler.mode).toBe('command');
    expect(() => exercise(handler)).not.toThrow();
  });

  it('CustomInputHandler is a no-op with mode custom', () => {
    const handler = new CustomInputHandler();
    expect(handler.mode).toBe('custom');
    expect(() => exercise(handler)).not.toThrow();
  });

  it('SearchInputHandler is a no-op with mode search', () => {
    const handler = new SearchInputHandler();
    expect(handler.mode).toBe('search');
    expect(() => exercise(handler)).not.toThrow();
  });
});
