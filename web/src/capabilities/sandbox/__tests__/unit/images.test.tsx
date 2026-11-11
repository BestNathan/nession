// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxImageSelection } from '@/generated/protocol/core/server-session-sandbox-context/v1';
import {
  sandboxImageChoice,
  sandboxImagesValid,
} from '../../model';
import { useSandboxImages } from '../../hooks/useSandboxImages';

const api = vi.hoisted(() => ({
  imageCacheStatuses: vi.fn(),
}));

vi.mock('../../SandboxPlugin', () => ({
  sandboxApi: api,
  SandboxPlugin: class SandboxPlugin {},
}));

const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('Sandbox image selections', () => {
  beforeEach(() => {
    api.imageCacheStatuses.mockReset();
    api.imageCacheStatuses.mockResolvedValue([
      { digest: DIGEST, state: 'verified' },
    ]);
  });

  it('infers the canonical role from the target and refuses invalid mode/target pairs', () => {
    expect(
      sandboxImageChoice({ digest: DIGEST, target: '/', mode: 'read_only' }),
    ).toEqual({
      choice: { role: 'base', digest: DIGEST, mode: 'read_only' },
    });
    expect(
      sandboxImageChoice({ digest: DIGEST, target: '/workspace', mode: 'overlay' }),
    ).toEqual({
      choice: { role: 'workspace', digest: DIGEST, mode: 'overlay' },
    });
    expect(
      sandboxImageChoice({ digest: DIGEST, target: '/opt/rust', mode: 'read_only' }),
    ).toEqual({
      choice: {
        role: 'toolchain',
        digest: DIGEST,
        target: '/opt/rust',
        mode: 'read_only',
      },
    });
    expect(
      sandboxImageChoice({ digest: DIGEST, target: '/workspace', mode: 'read_only' }),
    ).toHaveProperty('error');
    expect(
      sandboxImageChoice({ digest: DIGEST, target: '/opt/rust', mode: 'overlay' }),
    ).toHaveProperty('error');
    expect(
      sandboxImageChoice({ digest: DIGEST, target: '/tmp', mode: 'read_only' }),
    ).toHaveProperty('error');
    expect(sandboxImagesValid([])).toBe(true);
    expect(
      sandboxImagesValid([
        { role: 'base', digest: DIGEST, mode: 'read_only' },
        { role: 'toolchain', digest: DIGEST, target: '/opt/a', mode: 'read_only' },
      ]),
    ).toBe(true);
    expect(
      sandboxImagesValid([
        { role: 'toolchain', digest: DIGEST, target: '/opt/a', mode: 'read_only' },
      ]),
    ).toBe(false);
  });

  it('adds one role each, rejects duplicates, removes, and reads the Agent cache', async () => {
    const { result } = renderHook(() => useSandboxImages('a1:s1'));
    const base: SandboxImageSelection = {
      role: 'base',
      digest: DIGEST,
      mode: 'read_only',
    };
    const toolchain: SandboxImageSelection = {
      role: 'toolchain',
      digest: `sha256:${'b'.repeat(64)}`,
      target: '/opt/rust',
      mode: 'read_only',
    };

    act(() => {
      expect(result.current.add(base)).toBeNull();
    });
    await waitFor(() => expect(api.imageCacheStatuses).toHaveBeenCalled());
    expect(api.imageCacheStatuses).toHaveBeenCalledWith('a1:s1', [DIGEST]);
    await waitFor(() =>
      expect(result.current.cacheStatuses.get(DIGEST)?.state).toBe('verified'),
    );

    act(() => {
      expect(result.current.add(base)).toContain('already has a Base Runtime');
    });
    act(() => {
      expect(result.current.add(toolchain)).toBeNull();
    });
    await waitFor(() => expect(result.current.selections).toHaveLength(2));
    act(() => {
      expect(result.current.add(toolchain)).toContain('already uses that /opt target');
    });

    act(() => result.current.remove(0));
    expect(result.current.selections).toEqual([toolchain]);
  });
});
