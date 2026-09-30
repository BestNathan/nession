import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTranscriptItems } from '../../useTranscriptItems';
import { claudeCodeApi } from '../../../ClaudeCodePlugin';
import type { ClaudeCodeTranscriptItemsResponse } from '../../../types';

vi.mock('../../../ClaudeCodePlugin', () => ({
  claudeCodeApi: {
    claudeCodeTranscriptItems: vi.fn(),
  },
}));

function itemsResponse(
  overrides: Partial<ClaudeCodeTranscriptItemsResponse> = {},
): ClaudeCodeTranscriptItemsResponse {
  return {
    state: 'ready',
    items: [],
    has_more: false,
    partial_tail: false,
    ...overrides,
  };
}

function message(id: string): NonNullable<ClaudeCodeTranscriptItemsResponse['items']>[number] {
  return { kind: 'message', id, source: 'human', content: [{ type: 'text', text: id }] };
}

const items = vi.mocked(claudeCodeApi.claudeCodeTranscriptItems);

describe('useTranscriptItems', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    items.mockReset();
  });

  it('stays not_found for an unknown id rather than substituting one', async () => {
    // The contract's substitution ban. A fallback here would be the same defect
    // one layer up, where it is harder to see: the caller named a transcript and
    // would be shown a different one with nothing to say so.
    items.mockResolvedValue(itemsResponse({ state: 'not_found' }));

    const { result } = renderHook(() =>
      useTranscriptItems({ agentId: 'a1', sessionId: 's', transcriptId: 'nope' }),
    );

    await waitFor(() => expect(result.current.items.loading).toBe(false));
    expect(result.current.items.state).toBe('not_found');
    expect(result.current.items.transcript).toBeNull();
    expect(result.current.items.items).toEqual([]);
    expect(items).toHaveBeenCalledTimes(1);
  });

  it('carries the parse accounting and the partial tail through', async () => {
    // This view's "is this everything?" is the counts, not one number that
    // cannot tell absorbed from unreadable — and a half-written last record is
    // a state the reader has to be able to see.
    items.mockResolvedValue(
      itemsResponse({
        items: [message('m1')],
        partial_tail: true,
        stats: {
          raw_records: 4,
          recognized_records: 2,
          metadata_absorbed: 1,
          unknown_records: 1,
          invalid_records: 0,
        },
      }),
    );

    const { result } = renderHook(() =>
      useTranscriptItems({ agentId: 'a1', sessionId: 's', transcriptId: 't' }),
    );

    await waitFor(() => expect(result.current.items.loading).toBe(false));
    expect(result.current.items.partialTail).toBe(true);
    expect(result.current.items.stats?.unknown_records).toBe(1);
  });

  it('puts an older page in front of what is on screen', async () => {
    items
      .mockResolvedValueOnce(itemsResponse({ items: [message('new')], has_more: true, next_cursor: '7' }))
      .mockResolvedValueOnce(itemsResponse({ items: [message('old')], has_more: false }));

    const { result } = renderHook(() =>
      useTranscriptItems({ agentId: 'a1', sessionId: 's', transcriptId: 't' }),
    );
    await waitFor(() => expect(result.current.items.items).toHaveLength(1));

    act(() => result.current.loadOlder());

    await waitFor(() => expect(result.current.items.items).toHaveLength(2));
    expect(result.current.items.items.map((i) => i.id)).toEqual(['old', 'new']);
  });

  it('does not let a poll rewind a reader who has already paged back', async () => {
    // The subtlety the cursor rule exists for. A poll re-reads the *newest*
    // page, so if it also wrote the older-cursor, a reader who had paged back
    // would find the next "load older" jumping forward to where they started.
    items
      .mockResolvedValueOnce(
        itemsResponse({ items: [message('new')], has_more: true, next_cursor: '7' }),
      )
      .mockResolvedValueOnce(
        itemsResponse({ items: [message('old')], has_more: true, next_cursor: '3' }),
      )
      .mockResolvedValueOnce(
        itemsResponse({ items: [message('new')], has_more: true, next_cursor: '7' }),
      )
      .mockResolvedValueOnce(itemsResponse({ items: [message('older')], has_more: false }));

    const { result } = renderHook(() =>
      useTranscriptItems({ agentId: 'a1', sessionId: 's', transcriptId: 't' }),
    );
    await waitFor(() => expect(result.current.items.items).toHaveLength(1));

    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.items.items).toHaveLength(2));

    act(() => result.current.poll());
    await waitFor(() => expect(items.mock.calls.length).toBe(3));

    act(() => result.current.loadOlder());
    await waitFor(() => expect(items.mock.calls.length).toBe(4));
    expect(items.mock.calls[3]?.[0]).toMatchObject({ cursor: '3' });
  });

  it('clears the previous transcript before the next one answers', async () => {
    items.mockResolvedValue(itemsResponse({ items: [message('m1')] }));

    const { result, rerender } = renderHook(
      ({ transcriptId }: { transcriptId: string }) =>
        useTranscriptItems({ agentId: 'a1', sessionId: 's', transcriptId }),
      { initialProps: { transcriptId: 't1' } },
    );
    await waitFor(() => expect(result.current.items.items).toHaveLength(1));

    rerender({ transcriptId: 't2' });

    expect(result.current.items.items).toEqual([]);
  });

  it('does not poll a transcript that is not live', async () => {
    // An inactive transcript is a finished one: re-reading it on a timer would
    // be work with no possible new answer, and the reader still has the page.
    items.mockResolvedValue(itemsResponse({ items: [message('m1')], activity: 'inactive' }));

    const { result } = renderHook(() =>
      useTranscriptItems({ agentId: 'a1', sessionId: 's', transcriptId: 't' }),
    );
    await waitFor(() => expect(result.current.items.loading).toBe(false));

    const callsAfterLoad = items.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect(items.mock.calls.length).toBe(callsAfterLoad);
  }, 10000);
});
