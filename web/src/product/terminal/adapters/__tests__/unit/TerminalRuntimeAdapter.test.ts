// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { getDefaultStore } from 'jotai';
import { createTerminalRuntimeAdapter } from '@/product/terminal/adapters/TerminalRuntimeAdapter';
import { inputModeAtomFamily } from '@/product/terminal/state/input';
import type { SessionRuntime } from '@/platform/session-runtime/SessionRuntime';

function makeRuntime() {
  return {
    setTransportReady: vi.fn<(ready: boolean) => void>(),
    updateViewportSize: vi.fn<(size: { cols: number; rows: number }) => void>(),
  } as unknown as SessionRuntime;
}

describe('TerminalRuntimeAdapter', () => {
  it('pushes viewport facts to the runtime, UI preference to jotai (#1309 SC-02)', () => {
    const store = getDefaultStore();
    const runtime = makeRuntime();
    const events = createTerminalRuntimeAdapter(runtime);

    events.onTransportReady?.(true);
    events.onInputModeChange?.('sess-1', { type: 'command' });
    events.onResize?.('sess-1', 120, 40);

    // Readiness and size have exactly one sink — the runtime. The Jotai atoms
    // they used to round-trip through are gone.
    expect(runtime.setTransportReady).toHaveBeenCalledWith(true);
    expect(runtime.updateViewportSize).toHaveBeenCalledWith({ cols: 120, rows: 40 });
    expect(store.get(inputModeAtomFamily('sess-1'))).toEqual({ type: 'command' });
  });
});
