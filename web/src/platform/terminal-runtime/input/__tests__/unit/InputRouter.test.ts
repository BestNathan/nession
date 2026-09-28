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

  it('registering for a mode releases the handler it replaces (#1096)', () => {
    // `wireTerminalUi` re-registers on a viewport reparent and reuses the same
    // router, so nothing else would release the previous handler and its
    // `terminal.onData` subscription would stay live.
    const router = new InputRouter();
    const first = makeHandler('terminal');
    const second = makeHandler('terminal');
    router.register(first);
    router.register(second);

    expect(first.deactivate).toHaveBeenCalledTimes(1);
    expect(second.deactivate).not.toHaveBeenCalled();
  });

  it('dispose releases every handler and activates none (#1096)', () => {
    // `detach()` used `setMode({ type: 'terminal' })` to mean "deactivate", but
    // setMode deactivates and then ACTIVATES the handler for the requested
    // mode — and the requested mode is the active one. The handler therefore
    // stayed subscribed on a router that was dropped, with nothing left to
    // release it, and every keystroke was sent once per leaked subscription.
    const router = new InputRouter();
    const terminal = makeHandler('terminal');
    const command = makeHandler('command');
    router.register(terminal);
    router.register(command);

    router.dispose();

    expect(terminal.deactivate).toHaveBeenCalledTimes(1);
    expect(command.deactivate).toHaveBeenCalledTimes(1);
    expect(terminal.activate).not.toHaveBeenCalled();
    expect(command.activate).not.toHaveBeenCalled();
  });

  it('routes nothing after dispose', () => {
    const router = new InputRouter();
    const terminal = makeHandler('terminal');
    router.register(terminal);

    router.dispose();
    router.route('a');

    expect(terminal.handle).not.toHaveBeenCalled();
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
