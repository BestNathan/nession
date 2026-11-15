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

function messageWithText(
  id: string,
  text: string,
): NonNullable<ClaudeCodeTranscriptItemsResponse['items']>[number] {
  return { kind: 'message', id, source: 'human', content: [{ type: 'text', text }] };
}

function message(id: string): NonNullable<ClaudeCodeTranscriptItemsResponse['items']>[number] {
  return messageWithText(id, id);
}

/** A response held open so a test can decide the order two requests finish in. */
function deferred() {
  let resolve: (value: ClaudeCodeTranscriptItemsResponse) => void = () => {};
  const promise = new Promise<ClaudeCodeTranscriptItemsResponse>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function idsOf(result: { current: { items: { items: { id: string }[] } } }): string[] {
  return result.current.items.items.map((entry) => entry.id);
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

  it('keeps a loaded older page when a poll re-reads the newest page', async () => {
    // #3606: a poll used to replace the whole timeline with the newest page, so
    // a reader who had paged back watched their history disappear on the next
    // refresh. The poll is authoritative for its own region only.
    items
      .mockResolvedValueOnce(
        itemsResponse({
          items: [message('b1'), message('b2')],
          has_more: true,
          next_cursor: 'cB',
          activity: 'inactive',
        }),
      )
      .mockResolvedValueOnce(
        itemsResponse({
          items: [message('a1'), message('a2')],
          has_more: true,
          next_cursor: 'cA',
          activity: 'inactive',
        }),
      )
      .mockResolvedValueOnce(
        itemsResponse({
          items: [messageWithText('b2', 'b2-updated'), message('b3')],
          has_more: true,
          next_cursor: 'cB2',
          activity: 'inactive',
        }),
      )
      .mockResolvedValueOnce(
        itemsResponse({ items: [message('a0')], has_more: false, activity: 'inactive' }),
      );

    const { result } = renderHook(() =>
      useTranscriptItems({ agentId: 'a1', sessionId: 's', transcriptId: 't' }),
    );
    await waitFor(() => expect(idsOf(result)).toEqual(['b1', 'b2']));

    act(() => result.current.loadOlder());
    await waitFor(() => expect(idsOf(result)).toEqual(['a1', 'a2', 'b1', 'b2']));

    act(() => result.current.poll());
    await waitFor(() => expect(idsOf(result)).toEqual(['a1', 'a2', 'b1', 'b2', 'b3']));
    // `b2` is the same entry the poll returned, not a second copy, and `b1` has
    // merely moved out of the newest page — it is still valid history.
    expect(idsOf(result).filter((id) => id === 'b2')).toHaveLength(1);
    // A changed entry is reconciled in place: the poll's newer value wins.
    const updated = result.current.items.items.find((entry) => entry.id === 'b2');
    if (updated?.kind !== 'message' || updated.content[0]?.type !== 'text') {
      throw new Error('the poll did not carry the updated entry');
    }
    expect(updated.content[0].text).toBe('b2-updated');

    // The next older page is still the one the reader had reached, not the
    // poll's newest-page cursor.
    act(() => result.current.loadOlder());
    await waitFor(() => expect(items.mock.calls.length).toBe(4));
    expect(items.mock.calls[3]?.[0]).toMatchObject({ cursor: 'cA' });
  });

  it('does not let a poll resurrect exhausted older pagination', async () => {
    items
      .mockResolvedValueOnce(
        itemsResponse({
          items: [message('b1')],
          has_more: true,
          next_cursor: 'cB',
          activity: 'inactive',
        }),
      )
      .mockResolvedValueOnce(
        itemsResponse({ items: [message('a1')], has_more: false, activity: 'inactive' }),
      )
      .mockResolvedValueOnce(
        itemsResponse({
          items: [message('b1'), message('b2')],
          has_more: true,
          next_cursor: 'cB2',
          activity: 'inactive',
        }),
      );

    const { result } = renderHook(() =>
      useTranscriptItems({ agentId: 'a1', sessionId: 's', transcriptId: 't' }),
    );
    await waitFor(() => expect(idsOf(result)).toEqual(['b1']));

    act(() => result.current.loadOlder());
    await waitFor(() => expect(idsOf(result)).toEqual(['a1', 'b1']));

    act(() => result.current.poll());
    await waitFor(() => expect(idsOf(result)).toEqual(['a1', 'b1', 'b2']));

    // The poll's newest page always has older records behind it; its
    // `has_more` says nothing about the boundary this reader has reached.
    expect(result.current.items.hasMore).toBe(false);
    act(() => result.current.loadOlder());
    expect(items.mock.calls.length).toBe(3);
  });

  it('keeps an older page that was in flight when a poll started', async () => {
    // SC-02, older answers first: one request-id counter used to make the later
    // request cancel the earlier one, so the poll silently discarded a valid
    // older page that had been requested before it.
    items.mockResolvedValueOnce(
      itemsResponse({
        items: [message('b1')],
        has_more: true,
        next_cursor: 'cB',
        activity: 'inactive',
      }),
    );
    const older = deferred();
    const polled = deferred();
    items.mockReturnValueOnce(older.promise).mockReturnValueOnce(polled.promise);

    const { result } = renderHook(() =>
      useTranscriptItems({ agentId: 'a1', sessionId: 's', transcriptId: 't' }),
    );
    await waitFor(() => expect(idsOf(result)).toEqual(['b1']));

    act(() => result.current.loadOlder());
    act(() => result.current.poll());

    await act(async () => {
      older.resolve(
        itemsResponse({
          items: [message('a1')],
          has_more: true,
          next_cursor: 'cA',
          activity: 'inactive',
        }),
      );
    });
    await waitFor(() => expect(idsOf(result)).toEqual(['a1', 'b1']));

    await act(async () => {
      polled.resolve(
        itemsResponse({
          items: [message('b1'), message('b2')],
          has_more: true,
          next_cursor: 'cB2',
          activity: 'inactive',
        }),
      );
    });
    await waitFor(() => expect(idsOf(result)).toEqual(['a1', 'b1', 'b2']));
  });

  it('applies an older page that answers after the poll that overlapped it', async () => {
    // SC-02, poll answers first. The older page belongs to an independently
    // arbitrated lane: the poll's completion must not invalidate it.
    items.mockResolvedValueOnce(
      itemsResponse({
        items: [message('b1')],
        has_more: true,
        next_cursor: 'cB',
        activity: 'inactive',
      }),
    );
    const older = deferred();
    const polled = deferred();
    items.mockReturnValueOnce(older.promise).mockReturnValueOnce(polled.promise);

    const { result } = renderHook(() =>
      useTranscriptItems({ agentId: 'a1', sessionId: 's', transcriptId: 't' }),
    );
    await waitFor(() => expect(idsOf(result)).toEqual(['b1']));

    act(() => result.current.loadOlder());
    act(() => result.current.poll());

    await act(async () => {
      polled.resolve(
        itemsResponse({
          items: [message('b1'), message('b2')],
          has_more: true,
          next_cursor: 'cB2',
          activity: 'inactive',
        }),
      );
    });
    await waitFor(() => expect(idsOf(result)).toEqual(['b1', 'b2']));

    await act(async () => {
      older.resolve(
        itemsResponse({ items: [message('a1')], has_more: false, activity: 'inactive' }),
      );
    });
    await waitFor(() => expect(idsOf(result)).toEqual(['a1', 'b1', 'b2']));
  });

  it('drops in-flight older and poll answers when the selected transcript changes', async () => {
    // Hold the two in-flight promises so their answers can be released after
    // the selection has moved on.
    const older = deferred();
    const polled = deferred();
    items
      .mockResolvedValueOnce(
        itemsResponse({
          items: [message('t1a')],
          has_more: true,
          next_cursor: 'cB',
          activity: 'inactive',
        }),
      )
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(polled.promise)
      .mockResolvedValueOnce(
        itemsResponse({ items: [message('t2a')], activity: 'inactive' }),
      );

    const { result, rerender } = renderHook(
      ({ transcriptId }: { transcriptId: string }) =>
        useTranscriptItems({ agentId: 'a1', sessionId: 's', transcriptId }),
      { initialProps: { transcriptId: 't1' } },
    );
    await waitFor(() => expect(idsOf(result)).toEqual(['t1a']));

    act(() => result.current.loadOlder());
    act(() => result.current.poll());

    rerender({ transcriptId: 't2' });
    await waitFor(() => expect(idsOf(result)).toEqual(['t2a']));

    await act(async () => {
      older.resolve(
        itemsResponse({ items: [message('t1-old')], has_more: false, activity: 'inactive' }),
      );
      polled.resolve(
        itemsResponse({
          items: [message('t1-new')],
          has_more: true,
          next_cursor: 'cX',
          activity: 'inactive',
        }),
      );
    });

    // Neither late answer may land on the newly selected transcript.
    expect(idsOf(result)).toEqual(['t2a']);
    expect(result.current.items.hasMore).toBe(false);
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
