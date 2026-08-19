import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCommandHistory } from '@/hooks/useCommandHistory';

function mockLocalStorage() {
  const store: Record<string, string> = {};
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
  });
  return store;
}

describe('useCommandHistory', () => {
  let now = 0;
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    mockLocalStorage();
    // Return strictly increasing timestamps so addEntry() calls made in the
    // same millisecond produce distinct timestamps (dedup test depends on it).
    now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      now += 1000;
      return now;
    });
  });

  it('starts with empty history', () => {
    const { result } = renderHook(() => useCommandHistory());
    expect(result.current.history).toEqual([]);
  });

  it('adds a new entry', () => {
    const { result } = renderHook(() => useCommandHistory());
    act(() => { result.current.addEntry('ls -la'); });
    expect(result.current.history).toHaveLength(1);
    expect(result.current.history[0].command).toBe('ls -la');
    expect(result.current.history[0].timestamp).toBeGreaterThan(0);
    expect(typeof result.current.history[0].id).toBe('string');
  });

  it('deduplicates: same command updates timestamp and moves to front', () => {
    const { result } = renderHook(() => useCommandHistory());
    act(() => { result.current.addEntry('ls -la'); });
    const firstTimestamp = result.current.history[0].timestamp;
    const firstId = result.current.history[0].id;

    act(() => { result.current.addEntry('git status'); });
    act(() => { result.current.addEntry('ls -la'); }); // duplicate

    expect(result.current.history).toHaveLength(2);
    expect(result.current.history[0].command).toBe('ls -la'); // moved to front
    expect(result.current.history[0].id).toBe(firstId); // same id
    expect(result.current.history[0].timestamp).not.toBe(firstTimestamp); // updated
    expect(result.current.history[1].command).toBe('git status');
  });

  it('orders by most recent first', () => {
    const { result } = renderHook(() => useCommandHistory());
    act(() => { result.current.addEntry('first'); });
    act(() => { result.current.addEntry('second'); });
    act(() => { result.current.addEntry('third'); });
    expect(result.current.history[0].command).toBe('third');
    expect(result.current.history[1].command).toBe('second');
    expect(result.current.history[2].command).toBe('first');
  });

  it('evicts oldest entry when exceeding max (500)', () => {
    const { result } = renderHook(() => useCommandHistory());
    act(() => {
      for (let i = 0; i < 500; i++) {
        result.current.addEntry(`command-${i}`);
      }
    });
    expect(result.current.history).toHaveLength(500);
    expect(result.current.history[499].command).toBe('command-0');

    act(() => { result.current.addEntry('overflow'); });
    expect(result.current.history).toHaveLength(500);
    expect(result.current.history[0].command).toBe('overflow');
    expect(result.current.history[499].command).toBe('command-1');
  });

  it('removes an entry by id', () => {
    const { result } = renderHook(() => useCommandHistory());
    act(() => { result.current.addEntry('ls -la'); });
    act(() => { result.current.addEntry('git status'); });
    const targetId = result.current.history[1].id;

    act(() => { result.current.removeEntry(targetId); });
    expect(result.current.history).toHaveLength(1);
    expect(result.current.history[0].command).toBe('git status');
  });

  it('clears all history', () => {
    const { result } = renderHook(() => useCommandHistory());
    act(() => { result.current.addEntry('ls -la'); });
    act(() => { result.current.addEntry('git status'); });
    act(() => { result.current.clearHistory(); });
    expect(result.current.history).toEqual([]);
  });

  it('filterHistory returns matching entries case-insensitively', () => {
    const { result } = renderHook(() => useCommandHistory());
    act(() => { result.current.addEntry('git status'); });
    act(() => { result.current.addEntry('GIT PULL'); });
    act(() => { result.current.addEntry('npm test'); });

    const matches = result.current.filterHistory('git');
    expect(matches).toHaveLength(2);
    expect(matches[0].command).toBe('GIT PULL');
    expect(matches[1].command).toBe('git status');
  });

  it('filterHistory returns all sorted by recency when query is empty', () => {
    const { result } = renderHook(() => useCommandHistory());
    act(() => { result.current.addEntry('first'); });
    act(() => { result.current.addEntry('second'); });

    const matches = result.current.filterHistory('');
    expect(matches).toHaveLength(2);
    expect(matches[0].command).toBe('second');
  });

  it('filterHistory returns empty for no match', () => {
    const { result } = renderHook(() => useCommandHistory());
    act(() => { result.current.addEntry('ls -la'); });
    expect(result.current.filterHistory('nonexistent')).toEqual([]);
  });

  it('persists to localStorage', () => {
    const { result } = renderHook(() => useCommandHistory());
    act(() => { result.current.addEntry('ls -la'); });
    const stored = JSON.parse(localStorage.getItem('nession_command_history')!);
    expect(stored).toHaveLength(1);
    expect(stored[0].command).toBe('ls -la');
  });

  it('loads existing data from localStorage on init', () => {
    const existing = [
      { id: 'abc', command: 'existing-cmd', timestamp: Date.now() - 1000 },
    ];
    localStorage.setItem('nession_command_history', JSON.stringify(existing));

    const { result } = renderHook(() => useCommandHistory());
    expect(result.current.history).toHaveLength(1);
    expect(result.current.history[0].command).toBe('existing-cmd');
  });

  it('handles corrupted localStorage gracefully', () => {
    localStorage.setItem('nession_command_history', 'not-valid-json');
    const { result } = renderHook(() => useCommandHistory());
    expect(result.current.history).toEqual([]);
  });
});
