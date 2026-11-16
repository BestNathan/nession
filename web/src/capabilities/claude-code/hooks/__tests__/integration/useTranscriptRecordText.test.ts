import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTranscriptRecordText } from '../../useTranscriptRecordText';
import { claudeCodeApi } from '../../../ClaudeCodePlugin';
import type { ClaudeCodeTranscriptRecord } from '../../../types';

vi.mock('../../../ClaudeCodePlugin', () => ({
  claudeCodeApi: {
    claudeCodeTranscriptRecord: vi.fn(),
  },
}));

function record(overrides: Partial<ClaudeCodeTranscriptRecord> = {}): ClaudeCodeTranscriptRecord {
  return {
    record_ref: 'tr1:abc:0:0123456789abcdef',
    offset: 0,
    size_bytes: 6,
    ...overrides,
  };
}

const lookup = vi.mocked(claudeCodeApi.claudeCodeTranscriptRecord);

describe('useTranscriptRecordText', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lookup.mockReset();
  });

  it('uses a record the page already carried without another request', () => {
    const { result } = renderHook(() =>
      useTranscriptRecordText({
        agentId: 'a1',
        sessionId: 'a1:work',
        record: record({ raw: '{"type":"user"}' }),
        open: true,
      }),
    );

    expect(result.current.status).toBe('ready');
    expect(result.current.complete).toBe(true);
    expect(result.current.raw).toBe('{"type":"user"}');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('assembles a placeholder record from bounded chunks and says when it is complete', async () => {
    lookup
      .mockResolvedValueOnce({
        state: 'ready',
        record_ref: 'tr1:abc:0:0123456789abcdef',
        raw: 'abc',
        offset: 0,
        size_bytes: 6,
        has_more: true,
        next_offset: 3,
      })
      .mockResolvedValueOnce({
        state: 'ready',
        record_ref: 'tr1:abc:0:0123456789abcdef',
        raw: 'def',
        offset: 3,
        size_bytes: 6,
        has_more: false,
        next_offset: 6,
      });

    const { result } = renderHook(() =>
      useTranscriptRecordText({
        agentId: 'a1',
        sessionId: 'a1:work',
        record: record(),
        open: true,
      }),
    );

    await waitFor(() => expect(result.current.complete).toBe(true));
    expect(result.current.raw).toBe('abcdef');
    expect(result.current.loadedBytes).toBe(6);
    expect(lookup.mock.calls[0]?.[0]).not.toHaveProperty('offset');
    expect(lookup.mock.calls[1]?.[0]).toMatchObject({ offset: 3 });
  });

  it('never claims a stale or failed record is complete', async () => {
    lookup.mockResolvedValue({ state: 'stale_generation' });

    const { result } = renderHook(() =>
      useTranscriptRecordText({
        agentId: 'a1',
        sessionId: 'a1:work',
        record: record(),
        open: true,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.complete).toBe(false);
    expect(result.current.error).toContain('changed');
  });

  it('keeps a partial read readable but explicitly incomplete after a failure', async () => {
    lookup
      .mockResolvedValueOnce({
        state: 'ready',
        record_ref: 'tr1:abc:0:0123456789abcdef',
        raw: 'abc',
        offset: 0,
        size_bytes: 6,
        has_more: true,
        next_offset: 3,
      })
      .mockResolvedValueOnce({ state: 'error', error: 'the record read did not complete' });

    const { result } = renderHook(() =>
      useTranscriptRecordText({
        agentId: 'a1',
        sessionId: 'a1:work',
        record: record(),
        open: true,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.raw).toBe('abc');
    expect(result.current.complete).toBe(false);
    expect(result.current.error).toContain('did not complete');
  });

  it('does nothing until it is opened', () => {
    const { result } = renderHook(() =>
      useTranscriptRecordText({
        agentId: 'a1',
        sessionId: 'a1:work',
        record: record(),
        open: false,
      }),
    );

    expect(result.current.status).toBe('idle');
    expect(lookup).not.toHaveBeenCalled();
  });
});
