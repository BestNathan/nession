import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Session } from '@/types';

const { setProjectBindingMock } = vi.hoisted(() => ({
  setProjectBindingMock: vi.fn(),
}));

vi.mock('@/product/session', () => ({
  sessionsApi: { setProjectBinding: setProjectBindingMock },
}));

import { useSessionProjectBinding } from '@/app/useSessionProjectBinding';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: 'agent-1:s1',
    agent_id: 'agent-1',
    session_name: 's1',
    status: 'active',
    window_count: 1,
    attached_clients: 0,
    project_id: 'project-1',
    project_revision: 1,
    instance_id: 'instance-1',
    last_activity: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('useSessionProjectBinding', () => {
  beforeEach(() => {
    setProjectBindingMock.mockReset();
  });

  it('sends the observed revision and incarnation with the mutation', async () => {
    setProjectBindingMock.mockResolvedValue({ success: true, revision: 2 });
    const { result } = renderHook(() => useSessionProjectBinding());

    act(() => result.current.open(makeSession()));
    await act(async () => {
      await result.current.save('project-2');
    });

    expect(setProjectBindingMock).toHaveBeenCalledWith('agent-1:s1', 'project-2', {
      revision: 1,
      instanceId: 'instance-1',
    });
    expect(result.current.target).toBeNull();
    expect(result.current.conflict).toBe(false);
  });

  it('keeps the editor open and adopts the current token after a conflict', async () => {
    setProjectBindingMock.mockResolvedValueOnce({
      success: false,
      error_kind: 'conflict',
      revision: 2,
    });
    const { result } = renderHook(() => useSessionProjectBinding());

    act(() => result.current.open(makeSession()));
    await act(async () => {
      await result.current.save('project-2');
    });

    expect(result.current.conflict).toBe(true);
    expect(result.current.error).toContain('Another change was saved first');
    // The selection target survives so the user can review and retry, and the
    // pinned token is the fresher one the reply reported.
    expect(result.current.target).toMatchObject({
      session_id: 'agent-1:s1',
      project_id: 'project-1',
      project_revision: 2,
    });

    setProjectBindingMock.mockResolvedValueOnce({ success: true, revision: 3 });
    await act(async () => {
      await result.current.save('project-2');
    });

    expect(setProjectBindingMock).toHaveBeenLastCalledWith('agent-1:s1', 'project-2', {
      revision: 2,
      instanceId: 'instance-1',
    });
    expect(result.current.target).toBeNull();
  });

  it('omits the guards for a legacy Session without a reported token', async () => {
    setProjectBindingMock.mockResolvedValue({ success: true });
    const { result } = renderHook(() => useSessionProjectBinding());

    act(() =>
      result.current.open(
        makeSession({ project_id: null, project_revision: null, instance_id: null }),
      ),
    );
    await act(async () => {
      await result.current.save('project-2');
    });

    expect(setProjectBindingMock).toHaveBeenCalledWith('agent-1:s1', 'project-2', {
      revision: undefined,
      instanceId: undefined,
    });
  });
});
