import { useCallback, useEffect, useRef, useState } from 'react';
import { claudeCodeApi } from '../ClaudeCodePlugin';
import type {
  ClaudeCodeTranscriptItem,
  ClaudeCodeTranscriptRecord,
  ClaudeCodeTranscriptRecordsResponse,
} from '../types';

/** One page's worth. The provider clamps; it does not error. */
const PAGE_LIMIT = 50;

/** How often a live transcript is re-read, matching the conversation view. */
const POLL_INTERVAL_MS = 3000;

const STALE_MESSAGE =
  'The transcript changed while it was open. Reload it to continue reading where you were.';

export interface TranscriptRecordsState {
  state: ClaudeCodeTranscriptRecordsResponse['state'] | null;
  /** The transcript the page is from — the header, without joining the list. */
  transcript: ClaudeCodeTranscriptItem | null;
  activity: ClaudeCodeTranscriptRecordsResponse['activity'] | null;
  records: ClaudeCodeTranscriptRecord[];
  hasMore: boolean;
  /** The transcript ended mid-record when it was read. Not an error. */
  partialTail: boolean;
  loading: boolean;
  loadingOlder: boolean;
  error: string | null;
}

const EMPTY: TranscriptRecordsState = {
  state: null,
  transcript: null,
  activity: null,
  records: [],
  hasMore: false,
  partialTail: false,
  loading: true,
  loadingOlder: false,
  error: null,
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to read the transcript';
}

/** One copy of each record, first occurrence winning. */
function uniqueByRef(records: ClaudeCodeTranscriptRecord[]): ClaudeCodeTranscriptRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    if (seen.has(record.record_ref)) {
      return false;
    }
    seen.add(record.record_ref);
    return true;
  });
}

/**
 * Fold a freshly read newest page into the timeline (#3606, #3726).
 *
 * `record_ref` is the stable row identity: it names the transcript, the byte
 * offset and the file generation. A record the page carries replaces its
 * earlier copy; records the page does not carry are older history and stay in
 * front of it, because a poll re-reads the newest window and is not
 * authoritative for pages a reader already loaded.
 *
 * `has_more` and the older cursor describe the boundary the reader paged back
 * to, not the newest page — so they are written on the initial read only.
 */
function withNewestPage(
  current: TranscriptRecordsState,
  response: ClaudeCodeTranscriptRecordsResponse,
  initial: boolean,
): TranscriptRecordsState {
  const page = uniqueByRef(response.records ?? []);
  const pageRefs = new Set(page.map((record) => record.record_ref));
  return {
    state: response.state,
    transcript: response.transcript ?? current.transcript,
    activity: response.activity ?? null,
    records: [...current.records.filter((record) => !pageRefs.has(record.record_ref)), ...page],
    hasMore: initial ? response.has_more : current.hasMore,
    partialTail: response.partial_tail,
    loading: false,
    loadingOlder: current.loadingOlder,
    error: null,
  };
}

/** Put an older page in front of the timeline, identity-based like the newest. */
function withOlderPage(
  current: TranscriptRecordsState,
  response: ClaudeCodeTranscriptRecordsResponse,
): TranscriptRecordsState {
  const loaded = new Set(current.records.map((record) => record.record_ref));
  const page = uniqueByRef(response.records ?? []).filter(
    (record) => !loaded.has(record.record_ref),
  );
  return {
    state: response.state,
    transcript: response.transcript ?? current.transcript,
    activity: response.activity ?? null,
    records: [...page, ...current.records],
    hasMore: response.has_more,
    partialTail: response.partial_tail,
    loading: current.loading,
    loadingOlder: false,
    error: null,
  };
}

/**
 * Re-read the newest page while the transcript is live.
 *
 * Kept outside the hook body so the paging state machine stays readable and
 * the polling condition has one owner.
 */
function usePollWhileLive(records: TranscriptRecordsState, poll: () => void) {
  useEffect(() => {
    if (records.state !== 'ready' || records.activity === 'inactive') {
      return;
    }
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [records.state, records.activity, poll]);
}

type Lane = 'newest' | 'older';

/** The selection and lane request an in-flight answer belongs to. */
interface Ticket {
  key: string;
  selection: number;
  lane: Lane;
  request: number;
}

/** A response that is not a page: say why, and leave what is on screen alone. */
function withReadState(
  current: TranscriptRecordsState,
  response: ClaudeCodeTranscriptRecordsResponse,
  lane: Lane,
): TranscriptRecordsState {
  let error: string | null = null;
  if (response.state === 'error') {
    error = response.error ?? 'The transcript could not be read';
  } else if (response.state === 'stale_cursor') {
    error = STALE_MESSAGE;
  } else if (response.state === 'not_found') {
    error = 'That transcript is no longer here.';
  } else if (response.state === 'unavailable') {
    error = 'This Session’s working directory cannot be established.';
  }
  return lane === 'newest'
    ? { ...current, state: response.state, loading: false, error }
    : {
        ...current,
        state: response.state,
        loadingOlder: false,
        error,
        // The older boundary is unusable in every non-ready state; the helper
        // also cleared the cursor. Showing "Load earlier" again would offer a
        // retry against a cursor that no longer exists.
        hasMore: false,
      };
}

/**
 * One explicitly named transcript's raw records, paged (#3726).
 *
 * `transcriptId` is the only selection mechanism, and an unknown id stays
 * `not_found` — the hook does not fall back to the binding or to the newest.
 * Each response is a page of physical JSONL lines; nothing is classified here,
 * so the hook cannot lose a record by not understanding it.
 *
 * Polls while the transcript is live relative to the Session. A newest-page
 * poll and an older-page read are independently arbitrated: a poll must not
 * cancel a reader paging back, and an older page must not overwrite the newest
 * window's position.
 */
export function useTranscriptRecords({
  agentId,
  sessionId,
  transcriptId,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  transcriptId: string | null;
}) {
  const [records, setRecords] = useState<TranscriptRecordsState>(EMPTY);
  const contextKey =
    agentId && sessionId && transcriptId ? `${agentId}:${sessionId}:${transcriptId}` : null;
  const contextRef = useRef<string | null>(contextKey);
  /** The selection every in-flight answer must still match. */
  const generation = useRef(0);
  /** The latest newest-page and older-page read, per selection. */
  const requests = useRef<Record<Lane, number>>({ newest: 0, older: 0 });
  /** The oldest cursor this transcript has handed out; `null` when exhausted. */
  const olderCursor = useRef<string | null>(null);

  /** The next request id in `lane`, bound to the current selection. */
  const nextTicket = useCallback(
    (lane: Lane): Ticket => ({
      key: contextRef.current as string,
      selection: generation.current,
      lane,
      request: ++requests.current[lane],
    }),
    [],
  );

  const stillCurrent = useCallback(
    (ticket: Ticket) =>
      contextRef.current === ticket.key &&
      generation.current === ticket.selection &&
      requests.current[ticket.lane] === ticket.request,
    [],
  );

  const fetchPage = useCallback(
    async (
      ticket: Ticket,
      mode: 'initial' | 'poll' | 'older',
      cursor: string | undefined,
    ) => {
      const response = await claudeCodeApi.claudeCodeTranscriptRecords({
        agent_id: agentId as string,
        session_id: sessionId as string,
        transcript_id: transcriptId as string,
        limit: PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      });
      if (!stillCurrent(ticket)) {
        return;
      }
      if (response.state !== 'ready') {
        if (ticket.lane === 'older') {
          // A stale boundary cannot be retried against the same generation.
          olderCursor.current = null;
        }
        setRecords((current) => withReadState(current, response, ticket.lane));
        return;
      }
      if (ticket.lane === 'newest') {
        setRecords((current) => withNewestPage(current, response, mode === 'initial'));
        if (mode === 'initial') {
          olderCursor.current = response.has_more ? (response.next_cursor ?? null) : null;
        }
        return;
      }
      setRecords((current) => withOlderPage(current, response));
      olderCursor.current = response.has_more ? (response.next_cursor ?? null) : null;
    },
    [agentId, sessionId, transcriptId, stillCurrent],
  );

  const run = useCallback(
    (ticket: Ticket, mode: 'initial' | 'poll' | 'older', cursor: string | undefined) => {
      void fetchPage(ticket, mode, cursor).catch((error: unknown) => {
        if (stillCurrent(ticket)) {
          setRecords((current) => ({
            ...current,
            loading: ticket.lane === 'newest' ? false : current.loading,
            loadingOlder: ticket.lane === 'older' ? false : current.loadingOlder,
            error: message(error),
          }));
        }
      });
    },
    [fetchPage, stillCurrent],
  );

  // A different transcript is a different timeline: nothing about the old one
  // may remain, including its cursor, and no answer to its requests may land.
  useEffect(() => {
    contextRef.current = contextKey;
    ++generation.current;
    olderCursor.current = null;
    setRecords(EMPTY);
    if (!contextKey) {
      return;
    }
    run(nextTicket('newest'), 'initial', undefined);
  }, [contextKey, nextTicket, run]);

  /** Read the page before the oldest record on screen. */
  const loadOlder = useCallback(() => {
    const cursor = olderCursor.current;
    if (!contextRef.current || !cursor) {
      return;
    }
    setRecords((current) => ({ ...current, loadingOlder: true }));
    run(nextTicket('older'), 'older', cursor);
  }, [nextTicket, run]);

  /** Re-read the newest page — what the poll does. */
  const poll = useCallback(() => {
    if (!contextRef.current) {
      return;
    }
    run(nextTicket('newest'), 'poll', undefined);
  }, [nextTicket, run]);

  /** Start again from the newest page after a stale boundary. */
  const reload = useCallback(() => {
    if (!contextRef.current) {
      return;
    }
    olderCursor.current = null;
    setRecords((current) => ({ ...current, loading: true, error: null }));
    run(nextTicket('newest'), 'initial', undefined);
  }, [nextTicket, run]);

  usePollWhileLive(records, poll);

  return { records, loadOlder, poll, reload };
}
