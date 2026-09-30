import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTranscripts } from '../../useTranscripts';
import { claudeCodeApi } from '../../../ClaudeCodePlugin';
import type { ClaudeCodeTranscriptsResponse } from '../../../types';

vi.mock('../../../ClaudeCodePlugin', () => ({
  claudeCodeApi: {
    claudeCodeTranscripts: vi.fn(),
  },
}));

function transcriptsResponse(
  overrides: Partial<ClaudeCodeTranscriptsResponse> = {},
): ClaudeCodeTranscriptsResponse {
  return { state: 'ready', items: [], has_more: false, ...overrides };
}

const PRIMARY = {
  id: 'session-1',
  cwd: '/work',
  kind: 'primary' as const,
  title: 'a session',
};
const SIDECHAIN = {
  id: 'session-1/agent-a',
  cwd: '/work/web',
  kind: 'sidechain' as const,
  parent_id: 'session-1',
  agent_id: 'agent-a',
};

const transcripts = vi.mocked(claudeCodeApi.claudeCodeTranscripts);

describe('useTranscripts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transcripts.mockReset();
  });

  it('lists a session and the subagents it spawned, relation intact', async () => {
    // The difference from `useConversations`, and the reason both hooks exist:
    // this list is the only place a subagent is reachable.
    transcripts.mockResolvedValue(
      transcriptsResponse({ items: [SIDECHAIN, PRIMARY], cwd: '/work' }),
    );

    const { result } = renderHook(() =>
      useTranscripts({ agentId: 'a1', sessionId: 'a1:work' }),
    );

    await waitFor(() => expect(result.current.list.loading).toBe(false));
    expect(result.current.list.transcripts.map((t) => t.kind)).toEqual([
      'sidechain',
      'primary',
    ]);
    expect(result.current.list.transcripts[0]?.parent_id).toBe('session-1');
  });

  it('keeps the exact binding apart from the items', async () => {
    // A binding is a fact about the Session, not a property of a transcript —
    // the same transcript is another Session's unbound row.
    transcripts.mockResolvedValue(
      transcriptsResponse({
        items: [PRIMARY],
        binding: { transcript_id: 'session-1', activity: 'active' },
      }),
    );

    const { result } = renderHook(() =>
      useTranscripts({ agentId: 'a1', sessionId: 'a1:work' }),
    );

    await waitFor(() => expect(result.current.list.binding).not.toBeNull());
    expect(result.current.list.binding?.transcript_id).toBe('session-1');
  });

  it('does not present an unavailable answer as an empty directory', async () => {
    // `unavailable` says nothing about the cwd; an empty list would claim the
    // directory is empty, which is a different and unsupported fact.
    transcripts.mockResolvedValue(transcriptsResponse({ state: 'unavailable' }));

    const { result } = renderHook(() =>
      useTranscripts({ agentId: 'a1', sessionId: 'a1:work' }),
    );

    await waitFor(() => expect(result.current.list.loading).toBe(false));
    expect(result.current.list.state).toBe('unavailable');
    expect(result.current.list.transcripts).toEqual([]);
  });

  it('clears the previous Session before the next one answers', async () => {
    // A Session change is a different directory: nothing about the old one may
    // remain on screen, not the items and not the binding.
    transcripts.mockResolvedValue(
      transcriptsResponse({
        items: [PRIMARY],
        binding: { transcript_id: 'session-1', activity: 'active' },
      }),
    );

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useTranscripts({ agentId: 'a1', sessionId }),
      { initialProps: { sessionId: 'a1:work' } },
    );
    await waitFor(() => expect(result.current.list.transcripts).toHaveLength(1));

    rerender({ sessionId: 'a1:other' });

    expect(result.current.list.transcripts).toEqual([]);
    expect(result.current.list.binding).toBeNull();
  });

  it('asks again only when told to', async () => {
    transcripts.mockResolvedValue(transcriptsResponse({ items: [PRIMARY] }));

    const { result } = renderHook(() =>
      useTranscripts({ agentId: 'a1', sessionId: 'a1:work' }),
    );
    await waitFor(() => expect(result.current.list.loading).toBe(false));
    expect(transcripts).toHaveBeenCalledTimes(1);

    act(() => result.current.refresh());

    await waitFor(() => expect(transcripts).toHaveBeenCalledTimes(2));
  });
});
