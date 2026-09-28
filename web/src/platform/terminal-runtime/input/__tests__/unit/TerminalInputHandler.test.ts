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

  it('releases the previous subscription on a second activate (#1096)', () => {
    // `activate()` used to overwrite `unsub`, so the earlier subscription
    // became unreachable — nothing held a reference to dispose it and it
    // stayed live for the life of the terminal, sending every keystroke again.
    const interaction = new TerminalInteractionController(fakeTerminal(), vi.fn());
    const firstDispose = vi.fn();
    const secondDispose = vi.fn();
    const bindSpy = vi
      .spyOn(interaction, 'bindXtermOnData')
      .mockReturnValueOnce(firstDispose)
      .mockReturnValueOnce(secondDispose);

    const handler = new TerminalInputHandler(interaction);
    handler.activate();
    handler.activate();

    expect(bindSpy).toHaveBeenCalledTimes(2);
    expect(firstDispose).toHaveBeenCalledTimes(1);
    // The newest subscription is the live one.
    expect(secondDispose).not.toHaveBeenCalled();
  });
});
