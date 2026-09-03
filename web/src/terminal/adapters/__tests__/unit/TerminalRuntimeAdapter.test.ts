// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { getDefaultStore } from 'jotai';
import {
  bindTerminalRuntimeAdapter,
  createTerminalRuntimeAdapter,
} from '@/terminal/adapters/TerminalRuntimeAdapter';
import { terminalTransportReadyAtom } from '@/terminal/state/transport';
import { lastResizeAtom } from '@/terminal/state/terminal';
import { inputModeAtomFamily } from '@/terminal/state/input';
import type { TerminalController } from '@/terminal/controller/TerminalController';

describe('TerminalRuntimeAdapter', () => {
  it('mirrors controller events into jotai atoms', () => {
    const store = getDefaultStore();
    store.set(terminalTransportReadyAtom, false);
    const events = createTerminalRuntimeAdapter();

    events.onTransportReady?.(true);
    events.onInputModeChange?.('sess-1', { type: 'command' });
    events.onResize?.('sess-1', 120, 40);

    expect(store.get(terminalTransportReadyAtom)).toBe(true);
    expect(store.get(inputModeAtomFamily('sess-1'))).toEqual({ type: 'command' });
    expect(store.get(lastResizeAtom)).toEqual({ cols: 120, rows: 40 });
  });

  it('binds and unbinds controller events', () => {
    const store = getDefaultStore();
    const controller = { events: undefined } as Pick<TerminalController, 'events'>;

    const unbind = bindTerminalRuntimeAdapter(controller as TerminalController);
    controller.events?.onTransportReady?.(true);
    expect(store.get(terminalTransportReadyAtom)).toBe(true);

    unbind();
    expect(controller.events).toBeUndefined();
    expect(store.get(terminalTransportReadyAtom)).toBe(false);
  });
});
