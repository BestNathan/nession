import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { EnvFileRef } from '@/types';
import type { EnvGetResponse } from '@/capabilities/env/types';

const envApi = vi.hoisted(() => ({
  getEnvFile: vi.fn(),
}));

vi.mock('@/capabilities/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/capabilities/env')>()),
  envApi,
}));

import { useBindingPreview } from '@/capabilities/env/hooks/useBindingPreview';

const A: EnvFileRef = { name: 'a.env', source: 'server' };
const B: EnvFileRef = { name: 'b.env', source: 'server' };

function content(ref: EnvFileRef): EnvGetResponse {
  if (ref.name === 'a.env') {
    return { success: true, content: 'A=1\nX=1\n', in_use_by: [] };
  }
  if (ref.name === 'b.env') {
    return { success: true, content: 'X=2\nB=2\n', in_use_by: [] };
  }
  return { success: false, error: 'gone', in_use_by: [] };
}

describe('useBindingPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envApi.getEnvFile.mockImplementation(async (ref: EnvFileRef) => content(ref));
  });

  it('computes effective keys, overlaps and changed keys without rendering values', async () => {
    const { result } = renderHook(() => useBindingPreview([A], [A, B], true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.current?.keyCount).toBe(2);
    expect(result.current.draft?.keyCount).toBe(3);
    expect(result.current.draft?.overlaps).toEqual(['X']);
    expect(new Set(result.current.changed)).toEqual(new Set(['X', 'B']));
  });

  it('reorders the same cached contents when the draft order changes', async () => {
    const { result, rerender } = renderHook(
      ({ draft }: { draft: EnvFileRef[] }) =>
        useBindingPreview([A], draft, true),
      { initialProps: { draft: [A, B] } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.draft?.values.get('X')).toBe('2');

    rerender({ draft: [B, A] });
    await waitFor(() => expect(result.current.draft?.values.get('X')).toBe('1'));
    expect(result.current.loading).toBe(false);
    // The cache is reused, not refetched for the same identities.
    expect(envApi.getEnvFile).toHaveBeenCalledTimes(2);
  });

  it('reports an unreadable profile without failing the whole preview', async () => {
    const gone: EnvFileRef = { name: 'gone.env', source: 'server' };
    const { result } = renderHook(() => useBindingPreview([], [A, gone], true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.draft?.keyCount).toBe(2);
    expect(result.current.unavailable).toEqual([
      { ref: gone, error: 'gone' },
    ]);
  });

  it('fetches nothing while disabled', () => {
    const { result } = renderHook(() => useBindingPreview([A], [A, B], false));
    expect(result.current.current).toBeNull();
    expect(result.current.draft).toBeNull();
    expect(envApi.getEnvFile).not.toHaveBeenCalled();
  });
});
