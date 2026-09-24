import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useConversation } from '../../useConversation';
import { claudeCodeApi } from '../../../ClaudeCodePlugin';
import type { ClaudeCodeConversationResponse } from '../../../types';

vi.mock('../../../ClaudeCodePlugin', () => ({
  claudeCodeApi: {
    claudeCodeConversation: vi.fn(),
  },
}));

function response(overrides: Partial<ClaudeCodeConversationResponse> = {}): ClaudeCodeConversationResponse {
  return {
    state: 'ready',
    conversation: { claude_session_id: 'claude-1', cwd: '/work' },
    candidates: [],
    items: [],
    has_more: false,
    partial_tail: false,
    skipped: 0,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('useConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(claudeCodeApi.claudeCodeConversation).mockReset();
  });

  it('asks for the bound conversation without naming one', async () => {
    // The mechanism of "auto-open on an exact binding" (#1005 criterion 2), and
    // the reason this hook cannot pick wrongly: the request carries no
    // `claude_session_id`, so the side holding the binding decides. Nothing here
    // could fall back to the newest transcript, because it never sees a list to
    // fall back *from*.
    vi.mocked(claudeCodeApi.claudeCodeConversation).mockResolvedValue(response());

    const { result } = renderHook(() => useConversation({ agentId: 'a', sessionId: 'a:s' }));

    await waitFor(() => expect(result.current.view.state).toBe('ready'));
    const sent = vi.mocked(claudeCodeApi.claudeCodeConversation).mock.calls[0][0];
    expect(sent).toMatchObject({ agent_id: 'a', session_id: 'a:s' });
    expect(sent).not.toHaveProperty('claude_session_id');
  });

  it('drops an answer that belongs to the Session the user has left', async () => {
    // #1005 criterion 9. The old Session's page arrives *after* the new one is on
    // screen, and rendering it would show another Session's conversation under
    // this one's name — the failure success criterion 1 is about.
    const slow = deferred<ClaudeCodeConversationResponse>();
    vi.mocked(claudeCodeApi.claudeCodeConversation)
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce(response({ conversation: { claude_session_id: 'claude-B', cwd: '/b' } }));

    const { result, rerender } = renderHook(
      ({ sessionId }) => useConversation({ agentId: 'a', sessionId }),
      { initialProps: { sessionId: 'a:first' } },
    );

    rerender({ sessionId: 'a:second' });
    await waitFor(() => expect(result.current.view.conversation?.claude_session_id).toBe('claude-B'));

    // Now the abandoned request answers.
    await act(async () => {
      slow.resolve(response({ conversation: { claude_session_id: 'claude-A', cwd: '/a' } }));
      await slow.promise;
    });

    expect(result.current.view.conversation?.claude_session_id).toBe('claude-B');
  });

  it('sends the chosen conversation back as the selection', async () => {
    vi.mocked(claudeCodeApi.claudeCodeConversation).mockResolvedValue(response());

    const { result } = renderHook(() => useConversation({ agentId: 'a', sessionId: 'a:s' }));
    await waitFor(() => expect(result.current.view.state).toBe('ready'));

    act(() => result.current.select('claude-2'));

    await waitFor(() => {
      const calls = vi.mocked(claudeCodeApi.claudeCodeConversation).mock.calls;
      expect(calls[calls.length - 1][0]).toMatchObject({ claude_session_id: 'claude-2' });
    });
  });

  it('keeps older items in front of the newest page after paging back', async () => {
    vi.mocked(claudeCodeApi.claudeCodeConversation)
      .mockResolvedValueOnce(
        response({
          items: [{ id: 'c', kind: 'user', text: 'c' }],
          next_cursor: '1',
          has_more: true,
        }),
      )
      .mockResolvedValueOnce(
        response({ items: [{ id: 'a', kind: 'user', text: 'a' }], next_cursor: null }),
      );

    const { result } = renderHook(() => useConversation({ agentId: 'a', sessionId: 'a:s' }));
    await waitFor(() => expect(result.current.view.items.map((i) => i.id)).toEqual(['c']));

    await act(async () => {
      await result.current.loadOlder();
    });

    expect(result.current.view.items.map((i) => i.id)).toEqual(['a', 'c']);
    expect(result.current.view.hasMore).toBe(false);
  });

  it('asks again on its own while the conversation is running', async () => {
    // #1005 criterion 3: a new turn appears without the user reloading.
    vi.useFakeTimers();
    try {
      vi.mocked(claudeCodeApi.claudeCodeConversation).mockResolvedValue(response({ state: 'ready' }));

      const { result } = renderHook(() => useConversation({ agentId: 'a', sessionId: 'a:s' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.view.state).toBe('ready');
      const afterFirstLoad = vi.mocked(claudeCodeApi.claudeCodeConversation).mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });
      expect(vi.mocked(claudeCodeApi.claudeCodeConversation).mock.calls.length).toBeGreaterThan(
        afterFirstLoad,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not poll a conversation that has stopped', async () => {
    // `inactive` means Claude has finished, and asking again forever would be
    // traffic for a file that is not being written to.
    vi.useFakeTimers();
    try {
      vi.mocked(claudeCodeApi.claudeCodeConversation).mockResolvedValue(response({ state: 'inactive' }));

      const { result } = renderHook(() => useConversation({ agentId: 'a', sessionId: 'a:s' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // Without this the test would pass for the wrong reason: nothing polling
      // and nothing loading look identical from the outside.
      expect(result.current.view.state).toBe('inactive');
      const afterFirstLoad = vi.mocked(claudeCodeApi.claudeCodeConversation).mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(vi.mocked(claudeCodeApi.claudeCodeConversation).mock.calls.length).toBe(afterFirstLoad);
    } finally {
      vi.useRealTimers();
    }
  });
});
