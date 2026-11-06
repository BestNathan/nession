import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNewEntryForm } from '@/capabilities/files/hooks/useNewEntryForm';

describe('useNewEntryForm', () => {
  it('captures the target and resets the form', () => {
    const { result } = renderHook(() => useNewEntryForm());

    act(() => result.current.open('file', 'src/components'));
    act(() => result.current.setNewName('Button.tsx'));

    expect(result.current.showNewFile).toBe(true);
    expect(result.current.parentPath).toBe('src/components');
    expect(result.current.destinationPath).toBe('src/components/Button.tsx');

    act(() => result.current.reset());

    expect(result.current.showNewFile).toBe(false);
    expect(result.current.showNewFolder).toBe(false);
    expect(result.current.target).toBeNull();
    expect(result.current.newName).toBe('');
  });

  it('rejects an invalid single path segment without rejecting a valid name', () => {
    const { result } = renderHook(() => useNewEntryForm());

    act(() => result.current.open('folder', 'src'));
    act(() => result.current.setNewName(''));
    expect(result.current.validationError).toBe('Enter a name.');
    expect(result.current.canSubmit).toBe(false);

    act(() => result.current.setNewName('../escape'));
    expect(result.current.validationError).toBe('Names cannot contain / or \\');
    expect(result.current.canSubmit).toBe(false);

    act(() => result.current.setNewName('components'));
    expect(result.current.validationError).toBeNull();
    expect(result.current.canSubmit).toBe(true);
  });

  it('keeps the destination as the captured parent, not a later path', () => {
    const { result } = renderHook(() => useNewEntryForm());

    act(() => result.current.open('file', 'src'));
    expect(result.current.parentPath).toBe('src');
    act(() => result.current.open('file', 'src/components'));
    expect(result.current.parentPath).toBe('src/components');
  });
});
