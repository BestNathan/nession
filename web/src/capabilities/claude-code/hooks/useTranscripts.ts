import { useCallback, useEffect, useState } from 'react';
import { claudeCodeApi } from '../ClaudeCodePlugin';
import type {
  ClaudeCodeTranscriptItem,
  ClaudeCodeTranscriptsResponse,
} from '../types';
import { usePullRefresh, type PullRefreshPolicy } from '@/platform/refresh';

/**
 * The exact Nession↔transcript binding, as the `transcripts` unit reports it
 * (#1234) — a relationship, not a property of any item.
 */
export type TranscriptBinding = NonNullable<ClaudeCodeTranscriptsResponse['binding']>;

/**
 * Ask for the provider's own ceiling rather than its smaller default page, so
 * the list is the whole directory in the common case. The provider clamps; it
 * does not error.
 */
const LIST_LIMIT = 200;

export interface TranscriptsListState {
  state: ClaudeCodeTranscriptsResponse['state'] | null;
  /**
   * The transcripts visible at the Session's cwd, newest first.
   *
   * **Not only sessions.** Unlike `useConversations`, this list includes the
   * subagents a session spawned, each with a `kind` and a `parent_id` — which
   * is the whole reason the two units are separate.
   */
  transcripts: ClaudeCodeTranscriptItem[];
  binding: TranscriptBinding | null;
  loading: boolean;
  error: string | null;
}

const EMPTY: TranscriptsListState = {
  state: null,
  transcripts: [],
  binding: null,
  loading: true,
  error: null,
};

/** A visible Claude list on the ordinary mutable-list cadence (#4602 §2). */
const TRANSCRIPTS_POLICY: PullRefreshPolicy = {
  intervalMs: 30_000,
  minIntervalMs: 3_000,
  timeoutMs: 15_000,
  onForeground: true,
  onReconnect: true,
  onActivate: true,
  autoRetry: true,
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to list the transcripts';
}

/**
 * The transcripts visible at one Session's cwd, and the exact binding.
 *
 * The directory is a mutable remote list: a new transcript or a moved binding
 * appears without the reader doing anything. #4602 supersedes the earlier
 * "manual only" decision for this list — it reads while visible on the ordinary
 * cadence, on show/resume/reconnect, and on an explicit refresh. The transcript
 * *records* timeline is immutable history and keeps its own live-tail owner.
 *
 * The subagents are listed and are not selected here. Which transcript to open
 * is the caller's decision — a list that auto-opened the session's own
 * transcript would make a subagent reachable only by accident.
 */
export function useTranscripts({
  agentId,
  sessionId,
  active = true,
  enabled = true,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  active?: boolean;
  enabled?: boolean;
}) {
  const [list, setList] = useState<TranscriptsListState>(EMPTY);
  const contextKey = agentId && sessionId ? `${agentId}:${sessionId}` : null;

  const apply = useCallback((response: ClaudeCodeTranscriptsResponse) => {
    setList({
      state: response.state,
      transcripts: response.items ?? [],
      binding: response.binding ?? null,
      loading: false,
      error:
        response.state === 'error'
          ? (response.error ?? 'The transcripts could not be listed')
          : null,
    });
  }, []);

  const { refresh: pull, status } = usePullRefresh<ClaudeCodeTranscriptsResponse>({
    context: ['claude-transcripts', contextKey],
    active: active && contextKey !== null,
    enabled: enabled && contextKey !== null,
    pull: () => claudeCodeApi.claudeCodeTranscripts({
      agent_id: agentId as string,
      session_id: sessionId as string,
      limit: LIST_LIMIT,
    }),
    apply,
    policy: TRANSCRIPTS_POLICY,
    label: 'claude-transcripts',
  });

  // A Session change is a different directory: nothing about the old one may
  // remain on screen — not the items, not the binding. The controller retires
  // the old read; this clears the projection it would otherwise leave behind.
  useEffect(() => {
    setList(EMPTY);
  }, [contextKey]);

  const refresh = useCallback(() => {
    if (!contextKey) { return; }
    void pull('manual');
  }, [contextKey, pull]);

  return {
    list: { ...list, loading: list.loading || status.loading },
    refresh,
    refreshing: status.refreshing,
    stale: status.stale,
    error: list.error ?? (status.error ? message(status.error) : null),
  };
}