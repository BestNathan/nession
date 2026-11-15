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

/** One copy of each entry, first occurrence winning. */
function uniqueById(entries: ClaudeCodeTranscriptEntry[]): ClaudeCodeTranscriptEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.id)) {
      return false;
    }
    seen.add(entry.id);
    return true;
  });
}

/**
 * Fold a freshly read newest page into the timeline (#3606).
 *
 * The page is authoritative for the entries it carries — a tool that finished
 * between polls comes back changed — so those replace their earlier copies and
 * move to the page's position. It is **not** authoritative for the whole
 * timeline once a reader has paged back: entries it does not carry are still
 * valid history, older than its oldest entry, and stay in front of it. The
 * previous newest page's entries that have merely moved out of the window are
 * therefore kept too; dropping them would open a gap that no cursor points at.
 */
function withNewestPage(
  current: TranscriptItemsState,
  response: ClaudeCodeTranscriptItemsResponse,
  initial: boolean,
): TranscriptItemsState {
  const page = uniqueById(response.items ?? []);
  const pageIds = new Set(page.map((entry) => entry.id));
  return {
    state: response.state,
    transcript: response.transcript ?? current.transcript,
    activity: response.activity ?? null,
    items: [...current.items.filter((entry) => !pageIds.has(entry.id)), ...page],
    // `has_more` and the older cursor describe the boundary the reader has
    // paged back to, not the newest page. A poll re-reads the newest page, so
    // its own `has_more` says nothing about that boundary: writing it would
    // either rewind the reader or resurrect pagination they exhausted. The
    // initial read establishes the boundary; an older page moves it.
    hasMore: initial ? response.has_more : current.hasMore,
    partialTail: response.partial_tail,
    stats: response.stats ?? null,
    loading: false,
    loadingOlder: current.loadingOlder,
    error: null,
  };
}

/**
 * Put an older page in front of the timeline.
 *
 * Identity-based like the newest merge: an id already on screen is one entry,
 * not two. A page that is entirely present is a no-op rather than a duplicate.
 */
function withOlderPage(
  current: TranscriptItemsState,
  response: ClaudeCodeTranscriptItemsResponse,
): TranscriptItemsState {
  const loaded = new Set(current.items.map((entry) => entry.id));
  const page = uniqueById(response.items ?? []).filter((entry) => !loaded.has(entry.id));
  return {
    state: response.state,
    transcript: response.transcript ?? current.transcript,
    activity: response.activity ?? null,
    items: [...page, ...current.items],
    hasMore: response.has_more,
    partialTail: response.partial_tail,
    stats: response.stats ?? null,
    loading: current.loading,
    loadingOlder: false,
    error: null,
  };
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
  current: TranscriptItemsState,
  response: ClaudeCodeTranscriptItemsResponse,
  lane: Lane,
): TranscriptItemsState {
  const error =
    response.state === 'error' ? (response.error ?? 'The transcript could not be read') : null;
  return lane === 'newest'
    ? { ...current, state: response.state, loading: false, error }
    : { ...current, state: response.state, loadingOlder: false, error };
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
 *
 * ## Identity and the two request lanes (#3606)
 *
 * Selection identity and request arbitration are separate concerns. `generation`
 * changes only when the selected transcript does, and no answer from an earlier
 * selection may land after it. Within one selection, a newest-page read and an
 * older-page read are independently arbitrated: a poll re-reads the newest page
 * while a reader may be paging back, and neither request may silently cancel
 * the other. Each lane keeps its own latest request id, so the newest answer in
 * a lane wins without touching the other lane's in-flight read.
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
  /** The selection every in-flight answer must still match. */
  const generation = useRef(0);
  /** The latest newest-page read, and the latest older-page read, per selection. */
  const newestRequest = useRef(0);
  const olderRequest = useRef(0);
  /** The oldest cursor this transcript has handed out; `null` when exhausted. */
  const olderCursor = useRef<string | null>(null);

  const stillCurrent = useCallback(
    (ticket: Ticket) =>
      contextRef.current === ticket.key &&
      generation.current === ticket.selection &&
      (ticket.lane === 'newest' ? newestRequest.current : olderRequest.current) ===
        ticket.request,
    [],
  );

  const fetchPage = useCallback(
    async (ticket: Ticket, mode: 'initial' | 'poll' | 'older', cursor: string | undefined) => {
      const response = await claudeCodeApi.claudeCodeTranscriptItems({
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
        setItems((current) => withReadState(current, response, ticket.lane));
        return;
      }
      if (ticket.lane === 'newest') {
        setItems((current) => withNewestPage(current, response, mode === 'initial'));
        // Where the next older page starts. Recorded on the initial read as
        // well as on an older one — a cursor kept only when paging would never
        // be set, so `loadOlder` could not fire at all. **Not on a poll**: it
        // re-reads the newest page, so writing this would either rewind a
        // reader who has already paged back or, with `has_more`, claim pages
        // they already exhausted.
        if (mode === 'initial') {
          olderCursor.current = response.has_more ? (response.next_cursor ?? null) : null;
        }
        return;
      }
      setItems((current) => withOlderPage(current, response));
      olderCursor.current = response.has_more ? (response.next_cursor ?? null) : null;
    },
    [agentId, sessionId, transcriptId, stillCurrent],
  );

  const failIfCurrent = useCallback(
    (ticket: Ticket, error: unknown) => {
      if (!stillCurrent(ticket)) {
        return;
      }
      setItems((current) =>
        ticket.lane === 'newest'
          ? { ...current, loading: false, error: message(error) }
          : { ...current, loadingOlder: false, error: message(error) },
      );
    },
    [stillCurrent],
  );

  // A different transcript is a different timeline: nothing about the old one
  // may remain, including its cursor, and no answer to its requests may land.
  useEffect(() => {
    contextRef.current = contextKey;
    const selection = ++generation.current;
    olderCursor.current = null;
    setItems(EMPTY);
    if (!contextKey) {
      return;
    }
    const ticket: Ticket = {
      key: contextKey,
      selection,
      lane: 'newest',
      request: ++newestRequest.current,
    };
    void fetchPage(ticket, 'initial', undefined).catch((e: unknown) => failIfCurrent(ticket, e));
  }, [contextKey, fetchPage, failIfCurrent]);

  /** Read the page before the oldest item on screen. */
  const loadOlder = useCallback(() => {
    const key = contextRef.current;
    const cursor = olderCursor.current;
    if (!key || !cursor) {
      return;
    }
    const ticket: Ticket = {
      key,
      selection: generation.current,
      lane: 'older',
      request: ++olderRequest.current,
    };
    setItems((current) => ({ ...current, loadingOlder: true }));
    void fetchPage(ticket, 'older', cursor).catch((e: unknown) => failIfCurrent(ticket, e));
  }, [failIfCurrent, fetchPage]);

  /** Re-read the newest page — what the poll does. */
  const poll = useCallback(() => {
    const key = contextRef.current;
    if (!key) {
      return;
    }
    const ticket: Ticket = {
      key,
      selection: generation.current,
      lane: 'newest',
      request: ++newestRequest.current,
    };
    void fetchPage(ticket, 'poll', undefined).catch(() => {
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
