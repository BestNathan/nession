import { act, renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import {
  useTerminalControlBridge,
  type TerminalControlSource,
} from '@/product/terminal/hooks/useTerminalControlBridge';
import type { TerminalControlState } from '@/product/terminal/state/terminalControl';

/** A route-agnostic source: the Relay plugin and the Agent API both fit it. */
function makeSource(initial: TerminalControlState) {
  let state = initial;
  const listeners = new Set<(name: string, next: TerminalControlState) => void>();
  const source: TerminalControlSource & {
    publish(next: TerminalControlState): void;
    acquireControl: ReturnType<typeof vi.fn>;
  } = {
    getControlState: () => state,
    onControlChanged: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    acquireControl: vi.fn(async () => ({ ok: true as const, generation: 7 })),
    publish(next) {
      state = next;
      for (const cb of listeners) {
        cb('sess', next);
      }
    },
  };
  return source;
}

describe('useTerminalControlBridge', () => {
  it('mirrors the active source and follows its notifications (#2157)', () => {
    const source = makeSource({ role: 'observer', generation: 3, controllerClientId: 'other' });
    const { result } = renderHook(() => useTerminalControlBridge('sess', source));

    expect(result.current.control.role).toBe('observer');

    act(() => {
      source.publish({ role: 'controller', generation: 4, controllerClientId: 'self' });
    });
    expect(result.current.control.role).toBe('controller');
    expect(result.current.control.generation).toBe(4);
  });

  it('writes the acquired role back through the same source', async () => {
    const source = makeSource({ role: 'observer', generation: 3, controllerClientId: 'other' });
    const { result } = renderHook(() => useTerminalControlBridge('sess', source));

    await act(async () => {
      await result.current.takeControl();
    });

    expect(source.acquireControl).toHaveBeenCalledExactlyOnceWith('sess');
    expect(result.current.control.role).toBe('controller');
  });

  it('does nothing without a source (no session yet)', async () => {
    const { result } = renderHook(() => useTerminalControlBridge('sess', null));
    await act(async () => {
      await result.current.takeControl();
    });
    // The default is the same optimistic controller the atom starts at.
    expect(result.current.control.role).toBe('controller');
  });

  it('adopts control automatically for an observer and says ownership moved (#2286)', async () => {
    const source = makeSource({ role: 'observer', generation: 3, controllerClientId: 'other' });
    const { result } = renderHook(() => useTerminalControlBridge('sess', source));

    let adopted: boolean | undefined;
    await act(async () => {
      adopted = await result.current.adoptControl();
    });

    expect(source.acquireControl).toHaveBeenCalledExactlyOnceWith('sess');
    expect(adopted).toBe(true);
    expect(result.current.control.role).toBe('controller');
    expect(result.current.control.generation).toBe(7);
  });

  it('does not re-acquire when this client already owns a known generation', async () => {
    const source = makeSource({ role: 'controller', generation: 5, controllerClientId: 'self' });
    const { result } = renderHook(() => useTerminalControlBridge('sess', source));

    let adopted: boolean | undefined;
    await act(async () => {
      adopted = await result.current.adoptControl();
    });

    expect(source.acquireControl).not.toHaveBeenCalled();
    expect(adopted).toBe(false);
  });

  it('asks once when the local role is only the optimistic default', async () => {
    // The atom starts at `controller` with no generation, and the attach reply
    // may have made this client an observer without a `control.changed`
    // broadcast. Adoption must not trust the default: it asks, and the Agent's
    // answer decides (#2286).
    const source = makeSource({ role: 'controller' });
    const { result } = renderHook(() => useTerminalControlBridge('sess', source));

    let adopted: boolean | undefined;
    await act(async () => {
      adopted = await result.current.adoptControl();
    });

    expect(source.acquireControl).toHaveBeenCalledExactlyOnceWith('sess');
    expect(adopted).toBe(true);
  });

  it('leaves the observer role alone when the acquire fails', async () => {
    const source = makeSource({ role: 'observer', generation: 3, controllerClientId: 'other' });
    source.acquireControl.mockResolvedValue({ ok: false as const, error: 'not_attached' });
    const { result } = renderHook(() => useTerminalControlBridge('sess', source));

    let adopted: boolean | undefined;
    await act(async () => {
      adopted = await result.current.adoptControl();
    });

    expect(adopted).toBe(false);
    expect(result.current.control.role).toBe('observer');
  });
});
