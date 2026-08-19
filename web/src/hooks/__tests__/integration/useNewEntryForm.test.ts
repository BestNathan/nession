// web/src/hooks/__tests__/useNewEntryForm.test.ts
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNewEntryForm } from '@/hooks/useNewEntryForm';

describe('useNewEntryForm', () => {
  it('resets the new-entry form state', () => {
    const { result } = renderHook(() => useNewEntryForm());

    act(() => result.current.setShowNewFile(true));
    act(() => result.current.setShowNewFolder(true));
    act(() => result.current.setNewName('untitled'));

    act(() => result.current.reset());

    expect(result.current.showNewFile).toBe(false);
    expect(result.current.showNewFolder).toBe(false);
    expect(result.current.newName).toBe('');
  });
});
