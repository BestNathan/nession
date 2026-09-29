import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useConversation } from '../../useConversation';
import { claudeCodeApi } from '../../../ClaudeCodePlugin';
import type {
  ClaudeCodeConversationsResponse,
  ClaudeCodeMessagesResponse,
} from '../../../types';

vi.mock('../../../ClaudeCodePlugin', () => ({
  claudeCodeApi: {
    claudeCodeConversations: vi.fn(),
    claudeCodeMessages: vi.fn(),
  },
}));

function conversationsResponse(
  overrides: Partial<ClaudeCodeConversationsResponse> = {},
): ClaudeCodeConversationsResponse {
  return {
    state: 'ready',
    cwd: '/work',
    items: [],
    has_more: false,
    ...overrides,
  };
}

function messagesResponse(
  overrides: Partial<ClaudeCodeMessagesResponse> = {},
): ClaudeCodeMessagesResponse {
  return {
    state: 'ready',
    items: [],
    has_more: false,
    partial_tail: false,
    skipped: 0,
    ...overrides,
  };
}

/** One message item, which is all these tests care about the shape of. */
function message(id: string): NonNullable<ClaudeCodeMessagesResponse['items']>[number] {
  return { id, kind: 'message', role: 'user', content: [{ type: 'text', text: id }] };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const conversations = vi.mocked(claudeCodeApi.claudeCodeConversations);
const messages = vi.mocked(claudeCodeApi.claudeCodeMessages);

describe('useConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    conversations.mockReset();
    messages.mockReset();
  });

  it('opens the conversation the binding names — and only that one', async () => {
    // The mechanism of "auto-open on an exact binding" (#1005 criterion 2) in
    // the only form #1222 allows: the list answers with the exact id, and the
    // messages request carries *that* id. Nothing here could fall back to the
    // newest transcript, because the client never names a conversation the
    // provider did not name first.
    conversations.mockResolvedValue(
      conversationsResponse({
        items: [{ id: 'claude-1', cwd: '/work' }],
        binding: { conversation_id: 'claude-1', activity: 'active' },
      }),
    );
    messages.mockResolvedValue(
      messagesResponse({ conversation: { id: 'claude-1', cwd: '/work' }, activity: 'active' }),
    );

    const { result } = renderHook(() => useConversation({ agentId: 'a', sessionId: 'a:s' }));

    await waitFor(() => expect(result.current.view.conversation?.id).toBe('claude-1'));
    const sent = messages.mock.calls[0][0];
    expect(sent).toMatchObject({ agent_id: 'a', session_id: 'a:s', conversation_id: 'claude-1' });
  });

  it('opens nothing when there is no binding — the list is the answer', async () => {
    // #1222: an unbound session is not an `ambiguous` state to resolve, it is a
    // list the user has not chosen from yet. No messages request may leave the
    // client until they do.
    conversations.mockResolvedValue(
      conversationsResponse({ items: [{ id: 'claude-1', cwd: '/work' }] }),
    );

    const { result } = renderHook(() => useConversation({ agentId: 'a', sessionId: 'a:s' }));

    await waitFor(() => expect(result.current.view.listState).toBe('ready'));
    expect(result.current.view.conversations.map((c) => c.id)).toEqual(['claude-1']);
    expect(result.current.view.conversation).toBeNull();
    expect(messages).not.toHaveBeenCalled();
  });

  it('drops an answer that belongs to the Session the user has left', async () => {
    // #1005 criterion 9. The old Session's page arrives *after* the new one is on
    // screen, and rendering it would show another Session's conversation under
    // this one's name — the failure success criterion 1 is about.
    conversations.mockImplementation((req) => {
      const id = req.session_id === 'a:first' ? 'claude-A' : 'claude-B';
      return Promise.resolve(
        conversationsResponse({
          items: [{ id, cwd: '/x' }],
          binding: { conversation_id: id, activity: 'active' },
        }),
      );
    });
    const slow = deferred<ClaudeCodeMessagesResponse>();
    messages
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValue(
        messagesResponse({ conversation: { id: 'claude-B', cwd: '/b' }, activity: 'active' }),
      );

    const { result, rerender } = renderHook(
      ({ sessionId }) => useConversation({ agentId: 'a', sessionId }),
      { initialProps: { sessionId: 'a:first' } },
    );

    // The abandoned request must actually be *abandoned*: rerendering before
    // it is in flight would hang the live one on `slow` instead.
    await waitFor(() => expect(messages).toHaveBeenCalledTimes(1));
    expect(messages.mock.calls[0][0]).toMatchObject({
      session_id: 'a:first',
      conversation_id: 'claude-A',
    });

    rerender({ sessionId: 'a:second' });
    await waitFor(() => expect(result.current.view.conversation?.id).toBe('claude-B'));

    // Now the abandoned request answers.
    await act(async () => {
      slow.resolve(
        messagesResponse({ conversation: { id: 'claude-A', cwd: '/a' }, activity: 'active' }),
      );
      await slow.promise;
    });

    expect(result.current.view.conversation?.id).toBe('claude-B');
  });

  it('sends the chosen conversation as an explicit id', async () => {
    conversations.mockResolvedValue(
      conversationsResponse({ items: [{ id: 'claude-1', cwd: '/work' }] }),
    );
    messages.mockResolvedValue(
      messagesResponse({ conversation: { id: 'claude-2', cwd: '/work' }, activity: 'inactive' }),
    );

    const { result } = renderHook(() => useConversation({ agentId: 'a', sessionId: 'a:s' }));
    await waitFor(() => expect(result.current.view.listState).toBe('ready'));

    act(() => result.current.select('claude-2'));

    await waitFor(() => {
      const calls = messages.mock.calls;
      expect(calls[calls.length - 1][0]).toMatchObject({ conversation_id: 'claude-2' });
    });
  });

  it('keeps older items in front of the newest page after paging back', async () => {
    conversations.mockResolvedValue(
      conversationsResponse({
        items: [{ id: 'claude-1', cwd: '/work' }],
        binding: { conversation_id: 'claude-1', activity: 'active' },
      }),
    );
    messages
      .mockResolvedValueOnce(
        messagesResponse({
          conversation: { id: 'claude-1', cwd: '/work' },
          activity: 'active',
          items: [message('c')],
          next_cursor: '1',
          has_more: true,
        }),
      )
      .mockResolvedValueOnce(messagesResponse({ items: [message('a')], next_cursor: null }));

    const { result } = renderHook(() => useConversation({ agentId: 'a', sessionId: 'a:s' }));
    await waitFor(() => expect(result.current.view.items.map((i) => i.id)).toEqual(['c']));

    await act(async () => {
      await result.current.loadOlder();
    });

    expect(result.current.view.items.map((i) => i.id)).toEqual(['a', 'c']);
    expect(result.current.view.hasMore).toBe(false);
  });

  it('polls the messages unit only — never the list (#1222)', async () => {
    // The timeline is the thing that grows under the reader; the list is
    // re-asked for on an explicit reload, not on a timer.
    vi.useFakeTimers();
    try {
      conversations.mockResolvedValue(
        conversationsResponse({
          items: [{ id: 'claude-1', cwd: '/work' }],
          binding: { conversation_id: 'claude-1', activity: 'active' },
        }),
      );
      messages.mockResolvedValue(
        messagesResponse({ conversation: { id: 'claude-1', cwd: '/work' }, activity: 'active' }),
      );

      const { result } = renderHook(() => useConversation({ agentId: 'a', sessionId: 'a:s' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.view.messagesState).toBe('ready');
      const listCalls = conversations.mock.calls.length;
      const messageCalls = messages.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });
      expect(messages.mock.calls.length).toBeGreaterThan(messageCalls);
      expect(conversations.mock.calls.length).toBe(listCalls);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not drop an older page when a poll overlaps (#1190)', async () => {
    vi.useFakeTimers();
    try {
      conversations.mockResolvedValue(
        conversationsResponse({
          items: [{ id: 'claude-1', cwd: '/work' }],
          binding: { conversation_id: 'claude-1', activity: 'active' },
        }),
      );
      const olderDeferred = deferred<ClaudeCodeMessagesResponse>();
      messages
        .mockResolvedValueOnce(
          messagesResponse({
            conversation: { id: 'claude-1', cwd: '/work' },
            activity: 'active',
            items: [message('c')],
            next_cursor: '1',
            has_more: true,
          }),
        )
        .mockReturnValueOnce(olderDeferred.promise)
        .mockResolvedValueOnce(messagesResponse({ items: [message('c')] }));

      const { result } = renderHook(() => useConversation({ agentId: 'a', sessionId: 'a:s' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.view.items.map((i) => i.id)).toEqual(['c']);

      let loadPromise: Promise<void> = Promise.resolve();
      act(() => {
        loadPromise = result.current.loadOlder();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });

      await act(async () => {
        olderDeferred.resolve(messagesResponse({ items: [message('a')], next_cursor: null }));
        await loadPromise;
      });

      expect(result.current.view.items.map((i) => i.id)).toEqual(['a', 'c']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps readable items when older pagination fails (#1190)', async () => {
    conversations.mockResolvedValue(
      conversationsResponse({
        items: [{ id: 'claude-1', cwd: '/work' }],
        binding: { conversation_id: 'claude-1', activity: 'active' },
      }),
    );
    messages
      .mockResolvedValueOnce(
        messagesResponse({
          conversation: { id: 'claude-1', cwd: '/work' },
          activity: 'active',
          items: [message('c')],
          next_cursor: '1',
          has_more: true,
        }),
      )
      .mockRejectedValueOnce(new Error('older failed'));

    const { result } = renderHook(() => useConversation({ agentId: 'a', sessionId: 'a:s' }));
    await waitFor(() => expect(result.current.view.items.map((i) => i.id)).toEqual(['c']));

    await act(async () => {
      await result.current.loadOlder();
    });

    expect(result.current.view.items.map((i) => i.id)).toEqual(['c']);
    expect(result.current.view.olderError).toBe('older failed');
    expect(result.current.view.error).toBeNull();
  });

  it('does not poll a conversation that has stopped', async () => {
    // `inactive` means Claude has finished, and asking again forever would be
    // traffic for a file that is not being written to.
    vi.useFakeTimers();
    try {
      conversations.mockResolvedValue(
        conversationsResponse({
          items: [{ id: 'claude-1', cwd: '/work' }],
          binding: { conversation_id: 'claude-1', activity: 'inactive' },
        }),
      );
      messages.mockResolvedValue(
        messagesResponse({ conversation: { id: 'claude-1', cwd: '/work' }, activity: 'inactive' }),
      );

      const { result } = renderHook(() => useConversation({ agentId: 'a', sessionId: 'a:s' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // Without this the test would pass for the wrong reason: nothing polling
      // and nothing loading look identical from the outside.
      expect(result.current.view.activity).toBe('inactive');
      const messageCalls = messages.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(messages.mock.calls.length).toBe(messageCalls);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps polling when the host cannot say whether Claude is running', async () => {
    // `unknown` makes no claim — but a live conversation frozen on screen is
    // worse than a re-read that changes nothing, so the timer stays on.
    vi.useFakeTimers();
    try {
      conversations.mockResolvedValue(
        conversationsResponse({
          items: [{ id: 'claude-1', cwd: '/work' }],
          binding: { conversation_id: 'claude-1', activity: 'unknown' },
        }),
      );
      messages.mockResolvedValue(
        messagesResponse({ conversation: { id: 'claude-1', cwd: '/work' }, activity: 'unknown' }),
      );

      const { result } = renderHook(() => useConversation({ agentId: 'a', sessionId: 'a:s' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.view.activity).toBe('unknown');
      const messageCalls = messages.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });
      expect(messages.mock.calls.length).toBeGreaterThan(messageCalls);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-asks the list only when the user reloads', async () => {
    conversations.mockResolvedValue(conversationsResponse());
    const { result } = renderHook(() => useConversation({ agentId: 'a', sessionId: 'a:s' }));
    await waitFor(() => expect(result.current.view.listState).toBe('ready'));
    const listCalls = conversations.mock.calls.length;

    act(() => result.current.reload());

    await waitFor(() => expect(conversations.mock.calls.length).toBe(listCalls + 1));
  });
});
