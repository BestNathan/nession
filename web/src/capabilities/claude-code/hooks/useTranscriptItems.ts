import { useCallback, useEffect, useRef, useState } from 'react';
import { claudeCodeApi } from '../ClaudeCodePlugin';
import type {
  ClaudeCodeTranscriptEntry,
  ClaudeCodeTranscriptItem,
  ClaudeCodeTranscriptItemsResponse,
} from '../types';

/** One page's worth. The provider clamps; it does not error. */
const PAGE_LIMIT = 50;

/** How often a live transcript is re-read, matching the conversation view. */
const POLL_INTERVAL_MS = 3000;

export interface TranscriptItemsState {
  state: ClaudeCodeTranscriptItemsResponse['state'] | null;
  /** The transcript the page is from — the header, without joining the list. */
  transcript: ClaudeCodeTranscriptItem | null;
  activity: ClaudeCodeTranscriptItemsResponse['activity'] | null;
  items: ClaudeCodeTranscriptEntry[];
  hasMore: boolean;
  /** The transcript ended mid-record when it was read. Not an error. */
  partialTail: boolean;
  /** What the parser understood, which is this view's "is this everything?". */
  stats: ClaudeCodeTranscriptItemsResponse['stats'] | null;
  loading: boolean;
  loadingOlder: boolean;
  error: string | null;
}

const EMPTY: TranscriptItemsState = {
  state: null,
  transcript: null,
  activity: null,
  items: [],
  hasMore: false,
  partialTail: false,
  stats: null,
  loading: true,
  loadingOlder: false,
  error: null,
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to read the transcript';
}

/** Merge a ready page into the state — an older page goes in front, the newest replaces. */
function withPage(
  current: TranscriptItemsState,
  response: ClaudeCodeTranscriptItemsResponse,
  older: boolean,
): TranscriptItemsState {
  return {
    state: response.state,
    transcript: response.transcript ?? current.transcript,
    activity: response.activity ?? null,
    items: older ? [...(response.items ?? []), ...current.items] : (response.items ?? []),
    hasMore: response.has_more,
    partialTail: response.partial_tail,
    stats: response.stats ?? null,
    loading: false,
    loadingOlder: false,
    error: null,
  };
}

/**
 * One explicitly named transcript's execution timeline, paged (#1234).
 *
 * `transcriptId` is the only selection mechanism, and an unknown id stays
 * `not_found` — the hook does not fall back to the binding or to the newest.
 * The provider is explicit that a request naming one transcript must never be
 * answered with another, and a fallback here would be exactly that, one layer
 * up where it is harder to see.
 *
 * Polls while the transcript is live relative to the Session, like the
 * conversation timeline and for the same reason: an execution view that did not
 * follow along would be a still frame of a running thing.
 */
export function useTranscriptItems({
  agentId,
  sessionId,
  transcriptId,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  transcriptId: string | null;
}) {
  const [items, setItems] = useState<TranscriptItemsState>(EMPTY);
  const contextKey =
    agentId && sessionId && transcriptId ? `${agentId}:${sessionId}:${transcriptId}` : null;
  const contextRef = useRef<string | null>(contextKey);
  const requestId = useRef(0);
  /** The oldest cursor this transcript has handed out; `null` when exhausted. */
  const olderCursor = useRef<string | null>(null);

  const fetchPage = useCallback(
    async (
      key: string,
      id: number,
      cursor: string | undefined,
      mode: 'initial' | 'older' | 'poll',
    ) => {
      const response = await claudeCodeApi.claudeCodeTranscriptItems({
        agent_id: agentId as string,
        session_id: sessionId as string,
        transcript_id: transcriptId as string,
        limit: PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      });
      if (contextRef.current !== key || requestId.current !== id) {
        return;
      }
      if (response.state !== 'ready') {
        setItems((current) => ({
          ...current,
          state: response.state,
          loading: false,
          loadingOlder: false,
          error:
            response.state === 'error'
              ? (response.error ?? 'The transcript could not be read')
              : null,
        }));
        return;
      }
      setItems((current) => withPage(current, response, mode === 'older'));
      // Where the next older page starts. Recorded on the newest read as well
      // as on an older one — a cursor kept only when paging would never be set,
      // so `loadOlder` could not fire at all.
      //
      // **Not on a poll**: it re-reads the newest page, so writing this would
      // rewind a reader who has already paged back.
      if (mode !== 'poll') {
        olderCursor.current = response.has_more ? (response.next_cursor ?? null) : null;
      }
    },
    [agentId, sessionId, transcriptId],
  );

  const failIfCurrent = useCallback(
    (key: string, id: number, error: unknown) => {
      if (contextRef.current !== key || requestId.current !== id) {
        return;
      }
      setItems((current) => ({
        ...current,
        loading: false,
        loadingOlder: false,
        error: message(error),
      }));
    },
    [],
  );

  // A different transcript is a different timeline: nothing about the old one
  // may remain, including its cursor.
  useEffect(() => {
    contextRef.current = contextKey;
    const id = ++requestId.current;
    olderCursor.current = null;
    setItems(EMPTY);
    if (!contextKey) {
      return;
    }
    void fetchPage(contextKey, id, undefined, 'initial').catch((e: unknown) =>
      failIfCurrent(contextKey, id, e),
    );
  }, [contextKey, fetchPage, failIfCurrent]);

  /** Read the page before the oldest item on screen. */
  const loadOlder = useCallback(() => {
    const key = contextRef.current;
    const cursor = olderCursor.current;
    if (!key || !cursor) {
      return;
    }
    const id = ++requestId.current;
    setItems((current) => ({ ...current, loadingOlder: true }));
    void fetchPage(key, id, cursor, 'older').catch((e: unknown) =>
      failIfCurrent(key, id, e),
    );
  }, [failIfCurrent, fetchPage]);

  /** Re-read the newest page — what the poll does. */
  const poll = useCallback(() => {
    const key = contextRef.current;
    if (!key) {
      return;
    }
    const id = ++requestId.current;
    void fetchPage(key, id, undefined, 'poll').catch(() => {
      // A failed poll is not worth a banner — the reader still has the page
      // they were reading. The initial read is whose failure must be visible.
    });
  }, [fetchPage]);

  useEffect(() => {
    if (items.state !== 'ready' || items.activity === 'inactive') {
      return;
    }
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [items.state, items.activity, poll]);

  return { items, loadOlder, poll };
}
