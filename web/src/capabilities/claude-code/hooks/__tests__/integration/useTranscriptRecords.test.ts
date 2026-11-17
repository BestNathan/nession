import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTranscriptRecords } from '../../useTranscriptRecords';
import { claudeCodeApi } from '../../../ClaudeCodePlugin';
import type {
  ClaudeCodeTranscriptRecord,
  ClaudeCodeTranscriptRecordsResponse,
} from '../../../types';

vi.mock('../../../ClaudeCodePlugin', () => ({
  claudeCodeApi: {
    claudeCodeTranscriptRecords: vi.fn(),
  },
}));

function record(
  recordRef: string,
  raw: string | null = JSON.stringify({ type: 'user', message: { content: recordRef } }),
): ClaudeCodeTranscriptRecord {
  return {
    record_ref: recordRef,
    offset: 0,
    size_bytes: raw === null ? 1_200_000 : raw.length,
    ...(raw === null ? {} : { raw }),
  };
}

function page(
  records: ClaudeCodeTranscriptRecord[],
  overrides: Partial<ClaudeCodeTranscriptRecordsResponse> = {},
): ClaudeCodeTranscriptRecordsResponse {
  return {
    state: 'ready',
    records,
    has_more: false,
    partial_tail: false,
    ...overrides,
  };
}

const list = vi.mocked(claudeCodeApi.claudeCodeTranscriptRecords);

describe('useTranscriptRecords', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    list.mockReset();
  });

  it('keeps the page in source order and remembers the older boundary', async () => {
    list.mockResolvedValue(
      page([record('r1'), record('r2')], {
        has_more: true,
        next_cursor: 'older-1',
      }),
    );

    const { result } = renderHook(() =>
      useTranscriptRecords({ agentId: 'a1', sessionId: 'a1:work', transcriptId: 't1' }),
    );

    await waitFor(() => expect(result.current.records.loading).toBe(false));
    expect(result.current.records.records.map((entry) => entry.record_ref)).toEqual([
      'r1',
      'r2',
    ]);
    expect(result.current.records.hasMore).toBe(true);
  });

  it('prepends an older page without duplicating an already loaded record', async () => {
    list.mockResolvedValue(
      page([record('r3')], { has_more: true, next_cursor: 'older-1' }),
    );

    const { result } = renderHook(() =>
      useTranscriptRecords({ agentId: 'a1', sessionId: 'a1:work', transcriptId: 't1' }),
    );
    await waitFor(() => expect(result.current.records.records).toHaveLength(1));

    list.mockResolvedValue(page([record('r1'), record('r2'), record('r3')]));
    act(() => result.current.loadOlder());

    await waitFor(() => expect(result.current.records.loadingOlder).toBe(false));
    expect(result.current.records.records.map((entry) => entry.record_ref)).toEqual([
      'r1',
      'r2',
      'r3',
    ]);
    expect(result.current.records.hasMore).toBe(false);
  });

  it('replaces a changed record by reference and keeps older history on poll', async () => {
    // The page is authoritative for the records it carries — a finished tool
    // line can change — but it is not authoritative for pages already loaded.
    list.mockResolvedValue(page([record('r1'), record('r2')]));

    const { result } = renderHook(() =>
      useTranscriptRecords({ agentId: 'a1', sessionId: 'a1:work', transcriptId: 't1' }),
    );
    await waitFor(() => expect(result.current.records.records).toHaveLength(2));

    list.mockResolvedValue(
      page([
        { ...record('r2'), size_bytes: 999, raw: JSON.stringify({ type: 'system' }) },
        record('r3'),
      ]),
    );
    act(() => result.current.poll());

    await waitFor(() => expect(result.current.records.records).toHaveLength(3));
    expect(result.current.records.records.map((entry) => entry.record_ref)).toEqual([
      'r1',
      'r2',
      'r3',
    ]);
    expect(result.current.records.records[1]?.size_bytes).toBe(999);
  });

  it('does not rewind the older boundary when a poll reports a different window', async () => {
    list.mockResolvedValue(
      page([record('r2')], { has_more: true, next_cursor: 'older-1' }),
    );

    const { result } = renderHook(() =>
      useTranscriptRecords({ agentId: 'a1', sessionId: 'a1:work', transcriptId: 't1' }),
    );
    await waitFor(() => expect(result.current.records.hasMore).toBe(true));

    list.mockResolvedValue(page([record('r2')], { has_more: false }));
    act(() => result.current.poll());

    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(result.current.records.hasMore).toBe(true);
  });

  it('treats a stale older cursor as a reported error and stops offering more', async () => {
    list.mockResolvedValue(
      page([record('r2')], { has_more: true, next_cursor: 'older-1' }),
    );

    const { result } = renderHook(() =>
      useTranscriptRecords({ agentId: 'a1', sessionId: 'a1:work', transcriptId: 't1' }),
    );
    await waitFor(() => expect(result.current.records.records).toHaveLength(1));

    list.mockResolvedValue({
      state: 'stale_cursor',
      records: [],
      has_more: false,
      partial_tail: false,
    });
    act(() => result.current.loadOlder());

    await waitFor(() => expect(result.current.records.loadingOlder).toBe(false));
    expect(result.current.records.error).toContain('changed');
    expect(result.current.records.hasMore).toBe(false);
    // The records already read stay readable.
    expect(result.current.records.records).toHaveLength(1);
  });

  it('keeps not_found distinct from an empty transcript', async () => {
    list.mockResolvedValue({
      state: 'not_found',
      records: [],
      has_more: false,
      partial_tail: false,
    });

    const { result } = renderHook(() =>
      useTranscriptRecords({ agentId: 'a1', sessionId: 'a1:work', transcriptId: 'missing' }),
    );

    await waitFor(() => expect(result.current.records.loading).toBe(false));
    expect(result.current.records.state).toBe('not_found');
    expect(result.current.records.error).toContain('no longer here');
    expect(result.current.records.records).toEqual([]);
  });

  it('clears the previous transcript before the next one answers', async () => {
    list.mockResolvedValue(page([record('r1')]));

    const { result, rerender } = renderHook(
      ({ transcriptId }: { transcriptId: string }) =>
        useTranscriptRecords({ agentId: 'a1', sessionId: 'a1:work', transcriptId }),
      { initialProps: { transcriptId: 't1' } },
    );
    await waitFor(() => expect(result.current.records.records).toHaveLength(1));

    list.mockReturnValue(new Promise(() => {}));
    rerender({ transcriptId: 't2' });

    expect(result.current.records.records).toEqual([]);
    expect(result.current.records.loading).toBe(true);
  });

  it('asks for the newest page of a new transcript, not its older boundary', async () => {
    list.mockResolvedValue(page([record('r1')]));

    const { result, rerender } = renderHook(
      ({ transcriptId }: { transcriptId: string }) =>
        useTranscriptRecords({ agentId: 'a1', sessionId: 'a1:work', transcriptId }),
      { initialProps: { transcriptId: 't1' } },
    );
    await waitFor(() => expect(result.current.records.records).toHaveLength(1));

    rerender({ transcriptId: 't2' });

    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(list.mock.calls[1]?.[0]).toMatchObject({
      transcript_id: 't2',
    });
    expect(list.mock.calls[1]?.[0]).not.toHaveProperty('cursor');
  });
});
