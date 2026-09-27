// web/src/terminal/input/__tests__/InputRouter.test.ts
import { describe, it, expect, vi } from 'vitest';
import { InputRouter } from '@/platform/terminal-runtime/input/InputRouter';
import type { InputHandler } from '@/platform/terminal-runtime/input/InputHandler';

function makeHandler(mode: InputHandler['mode']) {
  return {
    mode,
    handle: vi.fn<(data: string) => void>(),
    activate: vi.fn<() => void>(),
    deactivate: vi.fn<() => void>(),
  };
}

describe('InputRouter', () => {
  it('defaults to terminal mode', () => {
    const router = new InputRouter();
    expect(router.getMode()).toEqual({ type: 'terminal' });
  });

  it('routes data to the registered handler for the current mode', () => {
    const router = new InputRouter();
    const terminal = makeHandler('terminal');
    router.register(terminal);

    router.route('a');

    expect(terminal.handle).toHaveBeenCalledWith('a');
  });

  it('deactivates the handler it replaces, so a re-register cannot leak', () => {
    // #1148. `TerminalController.wireTerminalUi` re-registers the terminal
    // handler when the viewport reparents and **reuses the same router**, so
    // nothing else deactivates the previous one. A replaced-but-still-active
    // handler keeps its `terminal.onData` subscription, and every emission then
    // reaches the PTY twice.
    const router = new InputRouter();
    const first = makeHandler('terminal');
    const second = makeHandler('terminal');
    router.register(first);
    first.activate();

    router.register(second);

    expect(first.deactivate).toHaveBeenCalledTimes(1);
    // The replacement is not implicitly activated — its caller does that.
    expect(second.activate).not.toHaveBeenCalled();
  });

  it('setMode re-activates a handler when the mode does not change', () => {
    // The trap behind #1148, pinned so `detach()` can never go back to it.
    // `setMode({ type: 'terminal' })` reads as "deactivate the terminal
    // handler", but it deactivates and then **re-activates** because the
    // requested mode is the active one — leaving the subscription live on a
    // router that is about to be dropped.
    const router = new InputRouter();
    const handler = makeHandler('terminal');
    router.register(handler);

    router.setMode({ type: 'terminal' });

    expect(handler.deactivate).toHaveBeenCalledTimes(1);
    expect(handler.activate).toHaveBeenCalledTimes(1);
  });

  it('deactivateCurrent leaves nothing subscribed', () => {
    const router = new InputRouter();
    const handler = makeHandler('terminal');
    router.register(handler);

    router.deactivateCurrent();

    expect(handler.deactivate).toHaveBeenCalledTimes(1);
    expect(handler.activate).not.toHaveBeenCalled();
  });

  it('setMode deactivates the current handler and activates the next', () => {
    const router = new InputRouter();
    const terminal = makeHandler('terminal');
    const command = makeHandler('command');
    router.register(terminal);
    router.register(command);

    router.setMode({ type: 'command' });

    expect(terminal.deactivate).toHaveBeenCalledTimes(1);
    expect(command.activate).toHaveBeenCalledTimes(1);
  });

  it('routes to the active handler after switching modes', () => {
    const router = new InputRouter();
    const terminal = makeHandler('terminal');
    const command = makeHandler('command');
    router.register(terminal);
    router.register(command);

    router.setMode({ type: 'command' });
    router.route('b');

    expect(command.handle).toHaveBeenCalledWith('b');
    expect(terminal.handle).not.toHaveBeenCalled();
  });
});
