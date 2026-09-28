// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAppFilesSelection } from '../../useAppFilesSelection';

describe('useAppFilesSelection', () => {
  it('enters on long-press seed and toggles on tap', () => {
    const { result } = renderHook(() => useAppFilesSelection());
    const entry = {
      name: 'a.ts',
      path: 'src/a.ts',
      full_path: '/tmp/src/a.ts',
      is_dir: false,
      size: 1,
      modified: 0,
    };

    act(() => result.current.enterWith(entry));
    expect(result.current.active).toBe(true);
    expect(result.current.isSelected('src/a.ts')).toBe(true);

    act(() => result.current.toggle(entry));
    expect(result.current.active).toBe(false);
  });
});
