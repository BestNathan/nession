// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { PRESETS } from '@/components/quickCommands';
import { useCapsuleCommands } from '@/session-first/capsule/useCapsuleCommands';

vi.mock('@/hooks/useQuickCommands', () => ({
  useQuickCommands: vi.fn(),
}));

vi.mock('@/hooks/useCommandHistory', () => ({
  useCommandHistory: vi.fn(),
}));

import { useQuickCommands } from '@/hooks/useQuickCommands';
import { useCommandHistory } from '@/hooks/useCommandHistory';

const mockAddEntry = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useQuickCommands).mockReturnValue({
    userCommands: [{ id: 'user-1', label: 'deploy', command: 'npm run deploy' }],
    addCommand: vi.fn().mockResolvedValue(undefined),
    deleteCommand: vi.fn().mockResolvedValue(undefined),
  });
  vi.mocked(useCommandHistory).mockReturnValue({
    addEntry: mockAddEntry,
    history: [],
    removeEntry: vi.fn(),
    clearHistory: vi.fn(),
    filterHistory: vi.fn().mockReturnValue([]),
  });
});

describe('useCapsuleCommands', () => {
  it('merges PRESETS and user commands in allCommands', () => {
    const { result } = renderHook(() => useCapsuleCommands(vi.fn()));
    expect(result.current.allCommands).toHaveLength(PRESETS.length + 1);
    expect(result.current.allCommands[result.current.allCommands.length - 1]?.label).toBe('deploy');
  });

  it('handleRun appends carriage return for non-raw commands', () => {
    const sendText = vi.fn();
    const { result } = renderHook(() => useCapsuleCommands(sendText));
    act(() => {
      result.current.handleRun(PRESETS[0]);
    });
    expect(sendText).toHaveBeenCalledWith('clear\r');
    expect(mockAddEntry).toHaveBeenCalledWith('clear');
  });

  it('handleRun sends raw commands verbatim', () => {
    const sendText = vi.fn();
    const ctrlC = PRESETS.find((preset) => preset.id === 'preset-ctrl-c');
    if (!ctrlC) {
      throw new Error('missing ctrl-c preset');
    }
    const { result } = renderHook(() => useCapsuleCommands(sendText));
    act(() => {
      result.current.handleRun(ctrlC);
    });
    expect(sendText).toHaveBeenCalledWith('\x03');
  });

  it('supports chain start, add, send, and cancel', () => {
    const sendText = vi.fn();
    const { result } = renderHook(() => useCapsuleCommands(sendText));

    act(() => {
      result.current.handleChainStart('\x1b');
    });
    expect(result.current.isChaining).toBe(true);
    expect(result.current.chainBuffer).toEqual(['\x1b']);

    act(() => {
      result.current.handleChainAdd('[A');
    });
    expect(result.current.chainBuffer).toEqual(['\x1b', '[A']);

    act(() => {
      result.current.sendChain();
    });
    expect(sendText).toHaveBeenCalledWith('\x1b[A');
    expect(result.current.isChaining).toBe(false);
    expect(result.current.chainBuffer).toEqual([]);

    act(() => {
      result.current.handleChainStart('\t');
      result.current.cancelChain();
    });
    expect(result.current.isChaining).toBe(false);
    expect(result.current.chainBuffer).toEqual([]);
  });
});
