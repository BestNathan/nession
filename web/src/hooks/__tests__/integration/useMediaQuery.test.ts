import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMediaQuery } from '@/hooks/useMediaQuery';

type Listener = (e: { matches: boolean }) => void;

function installMatchMedia(initialMatches: boolean) {
  let listener: Listener | null = null;
  const mql = {
    matches: initialMatches,
    media: '',
    addEventListener: (_: string, cb: Listener) => { listener = cb; },
    removeEventListener: () => { listener = null; },
  };
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(mql));
  return {
    emit: (matches: boolean) => {
      mql.matches = matches;
      listener?.({ matches });
    },
  };
}

describe('useMediaQuery', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('returns the initial match state', () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery('(max-width: 767px)'));
    expect(result.current).toBe(true);
  });

  it('updates when the media query changes', () => {
    const { emit } = installMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery('(max-width: 767px)'));
    expect(result.current).toBe(false);
    act(() => emit(true));
    expect(result.current).toBe(true);
  });
});
