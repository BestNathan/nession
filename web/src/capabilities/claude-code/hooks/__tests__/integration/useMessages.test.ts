import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMessages } from '../../useMessages';
import { claudeCodeApi } from '../../../ClaudeCodePlugin';
import type { ClaudeCodeMessagesResponse } from '../../../types';

vi.mock('../../../ClaudeCodePlugin', () => ({
  claudeCodeApi: {
    claudeCodeConversations: vi.fn(),
    claudeCodeMessages: vi.fn(),
  },
}));

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

const messages = vi.mocked(claudeCodeApi.claudeCodeMessages);

describe('useMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    messages.mockReset();
  });

  it('keeps an in-flight older fetch visible across a newest-page poll', async () => {
    // The poll re-reads the newest page every few seconds; its state write
    // must not stamp over `loadingOlder`/`olderError` while an older-page
    // fetch is in flight — doing so killed the spinner and disarmed the
    // scroll controller's fetch guard, so a second pull could double-fetch
    // the same page.
    const older = deferred<ClaudeCodeMessagesResponse>();
    messages
      .mockResolvedValueOnce(
        messagesResponse({ items: [message('new-1')], has_more: true, next_cursor: 'c-1' }),
      )
      .mockImplementationOnce(() => older.promise)
      .mockResolvedValue(messagesResponse({ items: [message('new-1')] }));

    const { result } = renderHook(() =>
      useMessages({ agentId: 'a', sessionId: 's', conversationId: 'c1' }),
    );
    await waitFor(() => expect(result.current.messages.loading).toBe(false));
    expect(result.current.messages.hasMore).toBe(true);

    // The engagement answer is synchronous — the scroll controller's anchor
    // bookkeeping depends on it.
    let engaged: boolean | undefined;
    act(() => {
      engaged = result.current.loadOlder();
    });
    expect(engaged).toBe(true);
    await waitFor(() => expect(result.current.messages.loadingOlder).toBe(true));

    // The 3s poll lands mid-flight.
    await act(async () => {
      result.current.poll();
    });
    expect(result.current.messages.loadingOlder).toBe(true);

    // The older fetch itself still owns clearing the flag.
    await act(async () => {
      older.resolve(
        messagesResponse({ items: [message('old-1')], has_more: false, next_cursor: null }),
      );
    });
    expect(result.current.messages.loadingOlder).toBe(false);
    expect(result.current.messages.items.map((item) => item.id)).toEqual(['old-1', 'new-1']);
  });

  it('answers false when there is no older page to fetch', () => {
    // No conversation is open, so there is no cursor to page from — the
    // scroll controller must learn that synchronously, not infer it later.
    const { result } = renderHook(() =>
      useMessages({ agentId: 'a', sessionId: 's', conversationId: null }),
    );

    let engaged: boolean | undefined;
    act(() => {
      engaged = result.current.loadOlder();
    });

    expect(engaged).toBe(false);
    expect(result.current.messages.loadingOlder).toBe(false);
  });
});
