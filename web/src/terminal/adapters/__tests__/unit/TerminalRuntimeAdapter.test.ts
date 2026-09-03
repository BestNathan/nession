// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { getDefaultStore } from 'jotai';
import { createTerminalRuntimeAdapter } from '@/terminal/adapters/TerminalRuntimeAdapter';
import { terminalTransportReadyAtom } from '@/terminal/state/transport';
import { lastResizeAtom } from '@/terminal/state/terminal';
import { inputModeAtomFamily } from '@/terminal/state/input';

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
});
