import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { EnvFileInfo } from '@/types';
import {
  editorTargetKey,
  useEnvironmentScreen,
} from '@/capabilities/env/hooks/useEnvironmentScreen';

function info(name: string, overrides: Partial<EnvFileInfo> = {}): EnvFileInfo {
  return { name, source: 'server', size: 5, modified: 0, var_count: 2, ...overrides };
}

describe('useEnvironmentScreen', () => {
  it('selects a profile by identity and clears on null', () => {
    const { result } = renderHook(() => useEnvironmentScreen());
    act(() => result.current.selectProfile(info('staging.env')));
    expect(result.current.selectedKey).toBe('server::staging.env');
    act(() => result.current.selectProfile(null));
    expect(result.current.selectedKey).toBeNull();
  });

  it('opens the Edit depths for existing, new, and duplicate targets', () => {
    const { result } = renderHook(() => useEnvironmentScreen());
    act(() => result.current.selectProfile(info('a.env')));
    act(() => result.current.startEdit());
    expect(result.current.editor).toEqual({ kind: 'existing' });

    act(() => result.current.startNew());
    expect(result.current.editor).toEqual({ kind: 'new' });
    expect(result.current.selectedKey).toBeNull();

    const source = info('b.env');
    act(() => result.current.startDuplicate(source));
    expect(result.current.editor).toEqual({ kind: 'duplicate', source });
  });

  it('guards a selection switch while dirty, and the confirm runs the pending action', () => {
    const { result } = renderHook(() => useEnvironmentScreen());
    act(() => result.current.selectProfile(info('a.env')));
    act(() => result.current.startEdit());
    act(() => result.current.setDirty(true));

    act(() => result.current.selectProfile(info('b.env')));
    expect(result.current.guardOpen).toBe(true);
    expect(result.current.selectedKey).toBe('server::a.env');
    expect(result.current.editor).not.toBeNull();

    act(() => result.current.confirmGuard());
    expect(result.current.guardOpen).toBe(false);
    expect(result.current.dirty).toBe(false);
    expect(result.current.selectedKey).toBe('server::b.env');
    expect(result.current.editor).toBeNull();
  });

  it('cancelling the guard keeps the dirty edit untouched', () => {
    const { result } = renderHook(() => useEnvironmentScreen());
    act(() => result.current.selectProfile(info('a.env')));
    act(() => result.current.startEdit());
    act(() => result.current.setDirty(true));

    act(() => result.current.selectProfile(info('b.env')));
    act(() => result.current.cancelGuard());
    expect(result.current.guardOpen).toBe(false);
    expect(result.current.dirty).toBe(true);
    expect(result.current.selectedKey).toBe('server::a.env');
    expect(result.current.editor).toEqual({ kind: 'existing' });
  });

  it('cancelEdit guards when dirty and closes immediately when clean', () => {
    const { result } = renderHook(() => useEnvironmentScreen());
    act(() => result.current.selectProfile(info('a.env')));
    act(() => result.current.startEdit());
    act(() => result.current.setDirty(true));
    act(() => result.current.cancelEdit());
    expect(result.current.editor).not.toBeNull();
    expect(result.current.guardOpen).toBe(true);
    act(() => result.current.confirmGuard());
    expect(result.current.editor).toBeNull();
  });

  it('finishEdit closes Edit unguarded and selects the saved profile', () => {
    const { result } = renderHook(() => useEnvironmentScreen());
    act(() => result.current.startNew());
    act(() => result.current.setDirty(true));
    act(() => result.current.finishEdit('server::new.env'));
    expect(result.current.editor).toBeNull();
    expect(result.current.dirty).toBe(false);
    expect(result.current.selectedKey).toBe('server::new.env');
  });

  it('finishEdit(null) clears the selection for a deleted profile', () => {
    const { result } = renderHook(() => useEnvironmentScreen());
    act(() => result.current.selectProfile(info('a.env')));
    act(() => result.current.finishEdit(null));
    expect(result.current.selectedKey).toBeNull();
  });

  it('leaveDepth pops the list when reading, and closes a clean edit back to the detail', () => {
    const { result } = renderHook(() => useEnvironmentScreen());
    act(() => result.current.selectProfile(info('a.env')));
    act(() => result.current.leaveDepth());
    expect(result.current.selectedKey).toBeNull();

    act(() => result.current.selectProfile(info('a.env')));
    act(() => result.current.startEdit());
    act(() => result.current.leaveDepth());
    expect(result.current.editor).toBeNull();
    expect(result.current.selectedKey).toBe('server::a.env');
  });

  it('leaveDepth guards a dirty edit instead of abandoning it', () => {
    const { result } = renderHook(() => useEnvironmentScreen());
    act(() => result.current.selectProfile(info('a.env')));
    act(() => result.current.startEdit());
    act(() => result.current.setDirty(true));
    act(() => result.current.leaveDepth());
    expect(result.current.guardOpen).toBe(true);
    expect(result.current.editor).not.toBeNull();
  });

  it('reset abandons selection, editor, dirty, and a pending guard', () => {
    const { result } = renderHook(() => useEnvironmentScreen());
    act(() => result.current.selectProfile(info('a.env')));
    act(() => result.current.startEdit());
    act(() => result.current.setDirty(true));
    act(() => result.current.selectProfile(info('b.env')));
    act(() => result.current.reset());
    expect(result.current.selectedKey).toBeNull();
    expect(result.current.editor).toBeNull();
    expect(result.current.dirty).toBe(false);
    expect(result.current.guardOpen).toBe(false);
  });
});

describe('editorTargetKey', () => {
  it('is one key per target, so drafts never cross targets', () => {
    expect(editorTargetKey({ kind: 'new' }, null)).toBe('new');
    expect(editorTargetKey({ kind: 'existing' }, 'server::a.env')).toBe('existing:server::a.env');
    expect(editorTargetKey({ kind: 'duplicate', source: info('a.env') }, null)).toBe(
      'duplicate:server::a.env',
    );
  });
});
