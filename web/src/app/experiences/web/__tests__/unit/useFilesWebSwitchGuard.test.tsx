// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  useFilesWebSwitchGuard,
  type FilesWebSelection,
} from '../../useFilesWebSwitchGuard';

function file(path: string): FilesWebSelection {
  return {
    ref: { sourceId: 'source-1', path },
    filename: path,
    size: 10,
  };
}

describe('useFilesWebSwitchGuard (#3171)', () => {
  it('switches a clean file directly and keeps the source-scoped selection', () => {
    const { result } = renderHook(() => useFilesWebSwitchGuard('source-1'));
    act(() => result.current.requestFile(file('a.txt')));
    expect(result.current.selected?.ref.path).toBe('a.txt');
    act(() => result.current.requestFile(file('b.txt')));
    expect(result.current.selected?.ref.path).toBe('b.txt');
    expect(result.current.switchState.pending).toBeNull();
  });

  it('keeps A and its draft on cancel; only discard opens B', () => {
    const { result } = renderHook(() => useFilesWebSwitchGuard('source-1'));
    act(() => result.current.requestFile(file('a.txt')));
    act(() => result.current.onDirtyChange(true));

    act(() => result.current.requestFile(file('b.txt')));
    expect(result.current.selected?.ref.path).toBe('a.txt');
    expect(result.current.switchState.pending?.ref.path).toBe('b.txt');

    act(() => result.current.switchState.cancel());
    expect(result.current.selected?.ref.path).toBe('a.txt');
    expect(result.current.switchState.pending).toBeNull();

    act(() => result.current.requestFile(file('b.txt')));
    act(() => result.current.switchState.discard());
    expect(result.current.selected?.ref.path).toBe('b.txt');
    expect(result.current.switchState.pending).toBeNull();
  });

  it('opens the first pending target and ignores repeated B/C requests', () => {
    const { result } = renderHook(() => useFilesWebSwitchGuard('source-1'));
    act(() => result.current.requestFile(file('a.txt')));
    act(() => result.current.onDirtyChange(true));
    act(() => result.current.requestFile(file('b.txt')));
    act(() => result.current.requestFile(file('c.txt')));
    expect(result.current.switchState.pending?.ref.path).toBe('b.txt');
    act(() => result.current.switchState.discard());
    expect(result.current.selected?.ref.path).toBe('b.txt');
  });

  it('switches only after a successful guarded save; failure keeps A and the error', async () => {
    const { result } = renderHook(() => useFilesWebSwitchGuard('source-1'));
    let outcome: 'saved' | 'conflict' | 'failed' = 'saved';
    act(() => result.current.requestFile(file('a.txt')));
    act(() => result.current.onDirtyChange(true));
    act(() => result.current.onSaveHandlerChange(async () => outcome));

    act(() => result.current.requestFile(file('b.txt')));
    await act(async () => {
      await result.current.switchState.save();
    });
    expect(result.current.selected?.ref.path).toBe('b.txt');

    // Re-open A dirty, fail the save, and confirm the draft stays selected.
    act(() => result.current.requestFile(file('a.txt')));
    act(() => result.current.onDirtyChange(true));
    outcome = 'failed';
    act(() => result.current.requestFile(file('c.txt')));
    await act(async () => {
      await result.current.switchState.save();
    });
    expect(result.current.selected?.ref.path).toBe('a.txt');
    expect(result.current.switchState.pending?.ref.path).toBe('c.txt');
    expect(result.current.switchState.error).toContain('could not be saved');

    // A conflict is owned by the viewer's conflict dialog: no switch, no
    // duplicate decision left in the navigation guard.
    outcome = 'conflict';
    await act(async () => {
      await result.current.switchState.save();
    });
    expect(result.current.selected?.ref.path).toBe('a.txt');
    expect(result.current.switchState.pending).toBeNull();
  });

  it('proceeds after an in-flight toolbar save completes and blocks a pending save', async () => {
    const { result } = renderHook(() => useFilesWebSwitchGuard('source-1'));
    const handler = vi.fn(async () => 'saved' as const);
    act(() => result.current.requestFile(file('a.txt')));
    act(() => result.current.onSaveHandlerChange(handler));
    act(() => result.current.onDirtyChange(true));
    act(() => result.current.onSavingChange(true));
    act(() => result.current.requestFile(file('b.txt')));
    expect(result.current.switchState.pending?.ref.path).toBe('b.txt');

    // The guard's own Save must not start a second write while one is in flight.
    await act(async () => {
      await result.current.switchState.save();
    });
    expect(handler).not.toHaveBeenCalled();

    // The in-flight save succeeded; the committed edit proceeds to B.
    act(() => {
      result.current.onDirtyChange(false);
      result.current.onSavingChange(false);
    });
    expect(result.current.selected?.ref.path).toBe('b.txt');
  });

  it('keeps the guard and explains a failed in-flight save', () => {
    const { result } = renderHook(() => useFilesWebSwitchGuard('source-1'));
    act(() => result.current.requestFile(file('a.txt')));
    act(() => result.current.onDirtyChange(true));
    act(() => result.current.onSavingChange(true));
    act(() => result.current.requestFile(file('b.txt')));
    act(() => result.current.onSavingChange(false));
    expect(result.current.selected?.ref.path).toBe('a.txt');
    expect(result.current.switchState.pending?.ref.path).toBe('b.txt');
    expect(result.current.switchState.error).toContain('did not complete');
  });

  it('resets selection and the pending decision when the source changes', () => {
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useFilesWebSwitchGuard(key),
      { initialProps: { key: 'source-1' } },
    );
    act(() => result.current.requestFile(file('a.txt')));
    act(() => result.current.onDirtyChange(true));
    act(() => result.current.requestFile(file('b.txt')));
    rerender({ key: 'source-2' });
    expect(result.current.selected).toBeNull();
    expect(result.current.switchState.pending).toBeNull();
  });
});
