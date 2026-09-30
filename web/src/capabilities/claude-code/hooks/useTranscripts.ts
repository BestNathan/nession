import { useCallback, useEffect, useRef, useState } from 'react';
import { claudeCodeApi } from '../ClaudeCodePlugin';
import type {
  ClaudeCodeTranscriptItem,
  ClaudeCodeTranscriptsResponse,
} from '../types';

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

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to list the transcripts';
}

/**
 * The transcripts visible at one Session's cwd, and the exact binding.
 *
 * Not polled, for the reason the conversation list is not: the list answers
 * "what is here", which does not grow under a reader the way a timeline does.
 * A new transcript or a moved binding is one `refresh` away.
 *
 * The subagents are listed and are not selected here. Which transcript to open
 * is the caller's decision — a list that auto-opened the session's own
 * transcript would make a subagent reachable only by accident.
 */
export function useTranscripts({
  agentId,
  sessionId,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
}) {
  const [list, setList] = useState<TranscriptsListState>(EMPTY);
  const contextKey = agentId && sessionId ? `${agentId}:${sessionId}` : null;
  const contextRef = useRef<string | null>(contextKey);
  const requestId = useRef(0);

  const fetchList = useCallback(
    async (key: string, id: number) => {
      const response = await claudeCodeApi.claudeCodeTranscripts({
        agent_id: agentId as string,
        session_id: sessionId as string,
        limit: LIST_LIMIT,
      });
      if (contextRef.current !== key || requestId.current !== id) {
        return;
      }
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
    },
    [agentId, sessionId],
  );

  const failIfCurrent = useCallback((key: string, id: number, error: unknown) => {
    if (contextRef.current !== key || requestId.current !== id) {
      return;
    }
    setList((current) => ({ ...current, loading: false, error: message(error) }));
  }, []);

  // A Session change is a different directory: nothing about the old one may
  // remain on screen — not the items, not the binding.
  useEffect(() => {
    contextRef.current = contextKey;
    const id = ++requestId.current;
    setList(EMPTY);
    if (!contextKey) {
      return;
    }
    void fetchList(contextKey, id).catch((e: unknown) => failIfCurrent(contextKey, id, e));
  }, [contextKey, fetchList, failIfCurrent]);

  /** Ask again — the only refresh the list gets, by design. */
  const refresh = useCallback(() => {
    const key = contextRef.current;
    if (!key) {
      return;
    }
    const id = ++requestId.current;
    void fetchList(key, id).catch((e: unknown) => failIfCurrent(key, id, e));
  }, [failIfCurrent, fetchList]);

  return { list, refresh };
}
