// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { TerminalInputHandler } from '@/platform/terminal-runtime/input/TerminalInputHandler';
import { TerminalInteractionController } from '@/platform/terminal-runtime/interaction/TerminalInteractionController';
import type { Terminal } from '@xterm/xterm';

function fakeTerminal(): Terminal {
  return {
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    input: vi.fn(),
    paste: vi.fn(),
    element: document.createElement('div'),
  } as unknown as Terminal;
}

describe('TerminalInputHandler', () => {
  it('forwards Ctrl+D to the PTY via the interaction layer (#1096)', () => {
    const sendToPty = vi.fn();
    const interaction = new TerminalInteractionController(fakeTerminal(), sendToPty);
    const bindSpy = vi.spyOn(interaction, 'bindXtermOnData').mockReturnValue(() => {});
    const handler = new TerminalInputHandler(interaction);
    handler.activate();
    expect(bindSpy).toHaveBeenCalled();
    handler.handle('\x04');
    expect(sendToPty).toHaveBeenCalledWith('\x04');
  });
});
