import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSessionFirstMobileNav } from '@/hooks/useSessionFirstMobileNav';

function mockMatchMedia(matches: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    matches,
    media: '(min-width: 1024px)',
    addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => {
      listeners.add(cb);
    },
    removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => {
      listeners.delete(cb);
    },
    dispatch: (next: boolean) => {
      mql.matches = next;
      for (const cb of listeners) {
        cb({ matches: next } as MediaQueryListEvent);
      }
    },
  };
  vi.stubGlobal('matchMedia', () => mql);
  return mql;
}

describe('useSessionFirstMobileNav', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows list only on narrow viewports until detail is opened', () => {
    mockMatchMedia(false);
    const { result } = renderHook(() => useSessionFirstMobileNav(null));
    expect(result.current.showList).toBe(true);
    expect(result.current.showDetail).toBe(false);

    act(() => {
      result.current.openDetail();
    });
    // No selection yet — detail still hidden
    expect(result.current.showDetail).toBe(false);
  });

  it('shows detail when opened with a selected session', () => {
    mockMatchMedia(false);
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useSessionFirstMobileNav(id),
      { initialProps: { id: null as string | null } },
    );

    act(() => {
      result.current.openDetail();
    });
    rerender({ id: 'a1:s1' });
    expect(result.current.showList).toBe(false);
    expect(result.current.showDetail).toBe(true);
  });

  it('returns to list on openList without clearing selection visibility rules', () => {
    mockMatchMedia(false);
    const { result } = renderHook(() => useSessionFirstMobileNav('a1:s1'));
    act(() => {
      result.current.openDetail();
    });
    expect(result.current.showDetail).toBe(true);
    act(() => {
      result.current.openList();
    });
    expect(result.current.showList).toBe(true);
    expect(result.current.showDetail).toBe(false);
  });

  it('hides the list on wide viewports (drawer replaces the list pane)', () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useSessionFirstMobileNav('a1:s1'));
    expect(result.current.showList).toBe(false);
    expect(result.current.showDetail).toBe(true);
  });

  it('opens detail when resizing from wide to narrow with a selection', () => {
    const mql = mockMatchMedia(true);
    const { result } = renderHook(() => useSessionFirstMobileNav('a1:s1'));
    expect(result.current.isWide).toBe(true);

    act(() => {
      mql.dispatch(false);
    });
    expect(result.current.showDetail).toBe(true);
    expect(result.current.showList).toBe(false);
  });
});
