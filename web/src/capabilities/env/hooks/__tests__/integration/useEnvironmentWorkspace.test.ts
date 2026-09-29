import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { EnvFileInfo, EnvWriteResponse } from '@/types';

const envApi = vi.hoisted(() => ({
  listEnvFiles: vi.fn(),
  getSessionEnvActive: vi.fn(),
  writeEnvFile: vi.fn(),
  deleteEnvFile: vi.fn(),
}));

vi.mock('@/capabilities/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/capabilities/env')>()),
  envApi,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { toast } from 'sonner';
import { useEnvironmentWorkspace } from '@/capabilities/env/hooks/useEnvironmentWorkspace';

function info(name: string, overrides: Partial<EnvFileInfo> = {}): EnvFileInfo {
  return { name, source: 'server', size: 5, modified: 0, var_count: 2, ...overrides };
}

describe('useEnvironmentWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envApi.listEnvFiles.mockResolvedValue({ files: [info('a.env'), info('b.env')] });
    envApi.getSessionEnvActive.mockResolvedValue({ active: [] });
    envApi.writeEnvFile.mockResolvedValue({ success: true } as EnvWriteResponse);
    envApi.deleteEnvFile.mockResolvedValue({ success: true });
  });

  it('derives the selected profile from the list, robust across refreshes', async () => {
    const { result } = renderHook(() => useEnvironmentWorkspace('s1'));
    await waitFor(() => expect(result.current.profiles.profiles).toHaveLength(2));
    act(() => result.current.screen.selectProfile(info('a.env')));
    expect(result.current.selectedProfile?.name).toBe('a.env');

    // A refresh that returns fresh objects keeps the same selection.
    envApi.listEnvFiles.mockResolvedValue({ files: [info('a.env'), info('b.env')] });
    await act(async () => {
      await result.current.profiles.refresh();
    });
    expect(result.current.selectedProfile?.name).toBe('a.env');
  });

  it('a Session switch resets the screen', async () => {
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) => useEnvironmentWorkspace(sessionId),
      { initialProps: { sessionId: 's1' as string | null } },
    );
    await waitFor(() => expect(result.current.profiles.profiles).toHaveLength(2));
    act(() => result.current.screen.selectProfile(info('a.env')));
    expect(result.current.selectedProfile).not.toBeNull();

    rerender({ sessionId: 's2' });
    expect(result.current.screen.selectedKey).toBeNull();
    expect(result.current.selectedProfile).toBeNull();
  });

  it('a successful save toasts, refreshes, and closes Edit onto the saved profile', async () => {
    const { result } = renderHook(() => useEnvironmentWorkspace(null));
    await waitFor(() => expect(result.current.profiles.profiles).toHaveLength(2));
    act(() => result.current.screen.startNew());

    let resp: EnvWriteResponse | undefined;
    await act(async () => {
      resp = await result.current.save({
        ref: { name: 'new.env', source: 'server' },
        content: 'A=1\n',
        overwrite: false,
        force: false,
      });
    });
    expect(resp?.success).toBe(true);
    expect(envApi.writeEnvFile).toHaveBeenCalledWith(
      { name: 'new.env', source: 'server' },
      'A=1\n',
      false,
      false,
    );
    expect(toast.success).toHaveBeenCalledWith('Saved new.env');
    expect(result.current.screen.editor).toBeNull();
    expect(result.current.screen.selectedKey).toBe('server::new.env');
  });

  it('re-source errors from a successful save surface as warnings', async () => {
    envApi.writeEnvFile.mockResolvedValue({
      success: true,
      re_source_errors: ['api: shell rejected export'],
    } as EnvWriteResponse);
    const { result } = renderHook(() => useEnvironmentWorkspace(null));
    await waitFor(() => expect(result.current.profiles.profiles).toHaveLength(2));
    await act(async () => {
      await result.current.save({
        ref: { name: 'a.env', source: 'server' },
        content: 'A=1\n',
        overwrite: true,
        force: true,
      });
    });
    expect(toast.warning).toHaveBeenCalledWith('api: shell rejected export');
  });

  it('a failed save is handed back untouched for the Replace/impact chain', async () => {
    envApi.writeEnvFile.mockResolvedValue({ success: false, exists: true } as EnvWriteResponse);
    const { result } = renderHook(() => useEnvironmentWorkspace(null));
    await waitFor(() => expect(result.current.profiles.profiles).toHaveLength(2));
    act(() => result.current.screen.startNew());

    let resp: EnvWriteResponse | undefined;
    await act(async () => {
      resp = await result.current.save({
        ref: { name: 'a.env', source: 'server' },
        content: 'A=1\n',
        overwrite: false,
        force: false,
      });
    });
    expect(resp?.exists).toBe(true);
    // The editor stays open and nothing is toasted — the chain continues.
    expect(result.current.screen.editor).not.toBeNull();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('delete toasts, clears the selection, and refreshes', async () => {
    const { result } = renderHook(() => useEnvironmentWorkspace(null));
    await waitFor(() => expect(result.current.profiles.profiles).toHaveLength(2));
    act(() => result.current.screen.selectProfile(info('a.env')));

    await act(async () => {
      await result.current.deleteProfile(info('a.env'));
    });
    expect(envApi.deleteEnvFile).toHaveBeenCalledWith({
      name: 'a.env',
      source: 'server',
      agent_id: undefined,
    });
    expect(toast.success).toHaveBeenCalledWith('Deleted a.env');
    expect(result.current.screen.selectedKey).toBeNull();
  });

  it('a failed delete toasts the error and keeps the profile selected', async () => {
    envApi.deleteEnvFile.mockResolvedValue({ success: false, error: 'in use' });
    const { result } = renderHook(() => useEnvironmentWorkspace(null));
    await waitFor(() => expect(result.current.profiles.profiles).toHaveLength(2));
    act(() => result.current.screen.selectProfile(info('a.env')));

    await act(async () => {
      await result.current.deleteProfile(info('a.env'));
    });
    expect(toast.error).toHaveBeenCalledWith('in use');
    expect(result.current.screen.selectedKey).toBe('server::a.env');
  });

  it('an import refreshes and selects the imported profile', async () => {
    const { result } = renderHook(() => useEnvironmentWorkspace(null));
    await waitFor(() => expect(result.current.profiles.profiles).toHaveLength(2));
    act(() => result.current.openImport());
    expect(result.current.importOpen).toBe(true);

    envApi.listEnvFiles.mockResolvedValue({
      files: [info('a.env'), info('b.env'), info('imported.env')],
    });
    await act(async () => {
      result.current.onImported({ name: 'imported.env', source: 'server' });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.screen.selectedKey).toBe('server::imported.env'));
    expect(toast.success).toHaveBeenCalledWith('Imported imported.env');
  });
});
