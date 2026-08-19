// web/src/terminal/input/__tests__/InputRouter.test.ts
import { describe, it, expect, vi } from 'vitest';
import { InputRouter } from '@/terminal/input/InputRouter';
import type { InputHandler } from '@/terminal/input/InputHandler';

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
