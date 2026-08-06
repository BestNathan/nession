import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVisualViewport } from '../useVisualViewport';

type Listener = (e: Event) => void;

interface MockVisualViewport {
  height: number;
  offsetTop: number;
  width: number;
  addEventListener: (event: string, listener: Listener) => void;
  removeEventListener: (event: string, listener: Listener) => void;
}

function installVisualViewport(initial: { height: number; offsetTop: number; width: number }) {
  const listeners: Record<string, Listener> = {};
  const vv: MockVisualViewport = {
    ...initial,
    addEventListener: vi.fn((event: string, listener: Listener) => {
      listeners[event] = listener;
    }),
    removeEventListener: vi.fn((event: string) => {
      delete listeners[event];
    }),
  };
  vi.stubGlobal('visualViewport', vv);
  vi.stubGlobal('innerHeight', 800);
  vi.stubGlobal('innerWidth', 400);
  // Return the mock itself (augmented with helpers) so tests can assert on
  // addEventListener/removeEventListener spy calls.
  return Object.assign(vv, {
    emit: (event: string) => {
      listeners[event]?.({} as Event);
    },
    updateProps: (props: Partial<{ height: number; offsetTop: number; width: number }>) => {
      Object.assign(vv, props);
    },
  });
}

describe('useVisualViewport', () => {
  beforeEach(() => {
    vi.stubGlobal('visualViewport', undefined);
    vi.stubGlobal('innerHeight', 800);
    vi.stubGlobal('innerWidth', 400);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns fallback values when visualViewport is not available', () => {
    const { result } = renderHook(() => useVisualViewport());
    expect(result.current.height).toBe(800);
    expect(result.current.isKeyboardOpen).toBe(false);
  });

  it('reads initial visualViewport values', () => {
    installVisualViewport({ height: 800, offsetTop: 0, width: 400 });
    const { result } = renderHook(() => useVisualViewport());
    expect(result.current.height).toBe(800);
    expect(result.current.isKeyboardOpen).toBe(false);
  });

  it('detects keyboard open when viewport height drops below 75%', () => {
    const { emit, updateProps } = installVisualViewport({ height: 800, offsetTop: 0, width: 400 });
    const { result } = renderHook(() => useVisualViewport());
    expect(result.current.isKeyboardOpen).toBe(false);

    updateProps({ height: 400, offsetTop: 0 });
    act(() => emit('resize'));
    expect(result.current.isKeyboardOpen).toBe(true);
    expect(result.current.height).toBe(400);
  });

  it('detects keyboard close when viewport height returns above 75%', () => {
    const { emit, updateProps } = installVisualViewport({ height: 400, offsetTop: 0, width: 400 });
    const { result } = renderHook(() => useVisualViewport());
    expect(result.current.isKeyboardOpen).toBe(true);

    updateProps({ height: 800, offsetTop: 0 });
    act(() => emit('resize'));
    expect(result.current.isKeyboardOpen).toBe(false);
  });

  it('listens to both resize and scroll events', () => {
    const vv = installVisualViewport({ height: 800, offsetTop: 0, width: 400 });
    renderHook(() => useVisualViewport());
    expect(vv.addEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(vv.addEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));
  });

  it('cleans up event listeners on unmount', () => {
    const vv = installVisualViewport({ height: 800, offsetTop: 0, width: 400 });
    const { unmount } = renderHook(() => useVisualViewport());
    unmount();
    expect(vv.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(vv.removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));
  });

  it('keyboard not open at exactly 75% threshold', () => {
    const { emit, updateProps } = installVisualViewport({ height: 800, offsetTop: 0, width: 400 });
    const { result } = renderHook(() => useVisualViewport());

    updateProps({ height: 600, offsetTop: 0 }); // exactly 75%
    act(() => emit('resize'));
    expect(result.current.isKeyboardOpen).toBe(false);
  });

  it('keyboard open below 75% (599/800)', () => {
    const { emit, updateProps } = installVisualViewport({ height: 800, offsetTop: 0, width: 400 });
    const { result } = renderHook(() => useVisualViewport());

    updateProps({ height: 599, offsetTop: 200 });
    act(() => emit('resize'));
    expect(result.current.isKeyboardOpen).toBe(true);
    expect(result.current.offsetTop).toBe(200);
  });
});
