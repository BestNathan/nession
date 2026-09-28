import { describe, it, expect, vi, type Mock } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { EnvWriteResponse } from '@/types';
import {
  useEnvProfileSave,
  type EnvProfileSaveInput,
} from '@/capabilities/env/hooks/useEnvProfileSave';

type OnSave = (input: EnvProfileSaveInput) => Promise<EnvWriteResponse>;

function input(overwrite: boolean, force: boolean): EnvProfileSaveInput {
  return { ref: { name: 'a.env', source: 'server' }, content: 'A=1\n', overwrite, force };
}

function setup(opts: { isNew?: boolean; inUseBy?: string[]; onSave?: Mock<OnSave> } = {}) {
  const onSave = opts.onSave ?? vi.fn<OnSave>(async () => ({ success: true }));
  const hook = renderHook(() =>
    useEnvProfileSave({
      isNew: opts.isNew ?? false,
      inUseBy: opts.inUseBy ?? [],
      buildInput: input,
      onSave,
    }),
  );
  return { onSave, ...hook };
}

describe('useEnvProfileSave', () => {
  it('an existing clean profile saves with overwrite and no force', async () => {
    const { result, onSave } = setup();
    await act(async () => result.current.save());
    expect(onSave).toHaveBeenCalledWith(input(true, false));
    expect(result.current.impactOpen).toBe(false);
  });

  it('a new profile attempts without overwrite first', async () => {
    const { result, onSave } = setup({ isNew: true });
    await act(async () => result.current.save());
    expect(onSave).toHaveBeenCalledWith(input(false, false));
  });

  it('an existing in-use profile explains the impact before any write', async () => {
    const { result, onSave } = setup({ inUseBy: ['api', 'web'] });
    await act(async () => result.current.save());
    expect(onSave).not.toHaveBeenCalled();
    expect(result.current.impactOpen).toBe(true);

    await act(async () => result.current.confirmImpact());
    expect(onSave).toHaveBeenCalledWith(input(true, true));
  });

  it('an exists answer opens Replace, which retries with overwrite', async () => {
    const onSave = vi
      .fn<OnSave>()
      .mockResolvedValueOnce({ success: false, exists: true })
      .mockResolvedValueOnce({ success: true });
    const { result } = setup({ isNew: true, onSave });
    await act(async () => result.current.save());
    expect(result.current.overwriteOpen).toBe(true);

    await act(async () => result.current.confirmOverwrite());
    expect(onSave).toHaveBeenLastCalledWith(input(true, false));
  });

  it('an in_use_by answer mid-chain escalates to the impact dialog', async () => {
    const onSave = vi
      .fn<OnSave>()
      .mockResolvedValueOnce({ success: false, exists: true })
      .mockResolvedValueOnce({ success: false, in_use_by: ['api'] })
      .mockResolvedValueOnce({ success: true });
    const { result } = setup({ isNew: true, onSave });
    await act(async () => result.current.save());
    await act(async () => result.current.confirmOverwrite());
    expect(result.current.impactOpen).toBe(true);

    await act(async () => result.current.confirmImpact());
    expect(onSave).toHaveBeenLastCalledWith(input(true, true));
  });

  it('a plain failure surfaces the error and opens nothing', async () => {
    const onSave = vi.fn<OnSave>(async () => ({ success: false, error: 'disk full' }));
    const { result } = setup({ onSave });
    await act(async () => result.current.save());
    expect(result.current.error).toBe('disk full');
    expect(result.current.impactOpen).toBe(false);
    expect(result.current.overwriteOpen).toBe(false);
  });
});
