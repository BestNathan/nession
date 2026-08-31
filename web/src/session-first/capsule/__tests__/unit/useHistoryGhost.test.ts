// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHistoryGhost } from '@/session-first/capsule/useHistoryGhost';
import type { HistoryEntry } from '@/hooks/useCommandHistory';

const entries: HistoryEntry[] = [
  { id: '1', command: 'aaa --verbose', timestamp: 200 },
  { id: '2', command: 'bbb', timestamp: 100 },
];

describe('useHistoryGhost', () => {
  it('returns no ghost for empty input', () => {
    const { result } = renderHook(() => useHistoryGhost('', entries));
    expect(result.current.ghostSuffix).toBe('');
    expect(result.current.hasGhost).toBe(false);
  });

  it('returns suffix for prefix match using most recent entry', () => {
    const { result } = renderHook(() => useHistoryGhost('aaa', entries));
    expect(result.current.ghostSuffix).toBe(' --verbose');
    expect(result.current.hasGhost).toBe(true);
  });

  it('returns no ghost when nothing matches prefix', () => {
    const { result } = renderHook(() => useHistoryGhost('zzz', entries));
    expect(result.current.ghostSuffix).toBe('');
  });

  it('acceptGhost appends suffix to current input', () => {
    const { result } = renderHook(() => useHistoryGhost('aaa', entries));
    let accepted = '';
    act(() => {
      accepted = result.current.acceptGhost();
    });
    expect(accepted).toBe('aaa --verbose');
  });
});
