// web/src/hooks/__tests__/useRenameState.test.ts
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRenameState } from '../useRenameState';

describe('useRenameState', () => {
  it('starts and cancels a rename', () => {
    const { result } = renderHook(() => useRenameState());

    act(() => result.current.startRename('/path/file.txt', 'old-name'));
    expect(result.current.renamingPath).toBe('/path/file.txt');
    expect(result.current.renameValue).toBe('old-name');

    act(() => result.current.cancelRename());
    expect(result.current.renamingPath).toBeNull();
    expect(result.current.renameValue).toBe('');
  });
});
