import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFloatingKeyBar } from '../useFloatingKeyBar';

describe('useFloatingKeyBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with visible=false and dismissed=false', () => {
    const { result } = renderHook(() => useFloatingKeyBar());
    expect(result.current.visible).toBe(false);
    expect(result.current.dismissed).toBe(false);
  });

  it('show makes visible=true', () => {
    const { result } = renderHook(() => useFloatingKeyBar());
    act(() => { result.current.show(); });
    expect(result.current.visible).toBe(true);
    expect(result.current.dismissed).toBe(false);
  });

  it('auto-hides after 3 seconds of inactivity', () => {
    const { result } = renderHook(() => useFloatingKeyBar());
    act(() => { result.current.show(); });
    expect(result.current.visible).toBe(true);

    act(() => { vi.advanceTimersByTime(3000); });
    expect(result.current.visible).toBe(false);
  });

  it('activity resets the auto-hide timer', () => {
    const { result } = renderHook(() => useFloatingKeyBar());
    act(() => { result.current.show(); });
    act(() => { vi.advanceTimersByTime(2000); });
    act(() => { result.current.onActivity(); });
    act(() => { vi.advanceTimersByTime(2000); });
    expect(result.current.visible).toBe(true);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current.visible).toBe(false);
  });

  it('dismiss sets visible=false and dismissed=true', () => {
    const { result } = renderHook(() => useFloatingKeyBar());
    act(() => { result.current.show(); });
    act(() => { result.current.dismiss(); });
    expect(result.current.visible).toBe(false);
    expect(result.current.dismissed).toBe(true);
  });

  it('restore clears dismissed and shows', () => {
    const { result } = renderHook(() => useFloatingKeyBar());
    act(() => { result.current.dismiss(); });
    expect(result.current.dismissed).toBe(true);

    act(() => { result.current.restore(); });
    expect(result.current.dismissed).toBe(false);
    expect(result.current.visible).toBe(true);
  });

  it('forceHide sets visible=false but preserves dismissed state', () => {
    const { result } = renderHook(() => useFloatingKeyBar());
    act(() => { result.current.show(); });
    act(() => { result.current.forceHide(); });
    expect(result.current.visible).toBe(false);
    expect(result.current.dismissed).toBe(false);
  });

  it('cleans up timer on unmount', () => {
    const { result, unmount } = renderHook(() => useFloatingKeyBar());
    act(() => { result.current.show(); });
    unmount();
    act(() => { vi.advanceTimersByTime(5000); });
    // No crash = pass
  });
});
