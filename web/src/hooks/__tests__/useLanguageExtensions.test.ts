import { describe, it, expect } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useLanguageExtensions } from '../useLanguageExtensions';

describe('useLanguageExtensions', () => {
  it('returns static language extensions immediately', () => {
    const { result } = renderHook(() => useLanguageExtensions('javascript'));
    expect(result.current.length).toBeGreaterThan(0);
  });

  it('returns an empty array for text', () => {
    const { result } = renderHook(() => useLanguageExtensions('text'));
    expect(result.current).toEqual([]);
  });

  it('resolves a lazily-loaded language and re-renders with its extensions', async () => {
    // shell is a legacy mode loaded via dynamic import — it starts unloaded,
    // then the hook flips to the loaded extensions once ensureLanguage resolves.
    const { result } = renderHook(() => useLanguageExtensions('shell'));
    expect(result.current).toEqual([]);

    await waitFor(() => {
      expect(result.current.length).toBeGreaterThan(0);
    });
  });
});
