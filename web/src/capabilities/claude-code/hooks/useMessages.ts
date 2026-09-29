import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { claudeCodeApi } from '../ClaudeCodePlugin';
import {
  emptyPositions,
  hasOlder,
  itemsOf,
  withNewest,
  withOlderPage,
  type MessageItems,
  type Positions,
} from '../model/messagePositions';
import type {
  ClaudeCodeConversationActivity,
  ClaudeCodeConversationItem,
  ClaudeCodeMessagesRequest,
  ClaudeCodeMessagesState,
} from '../types';

/** How many items one page asks for. The provider clamps this to its ceiling. */
const PAGE_LIMIT = 60;

export interface MessagesViewState {
  /** The provider's own word for what it could answer. */
  state: ClaudeCodeMessagesState | null;
  /**
   * The open conversation — the full item, from the response itself. This is
   * what kills the client-side join: the header renders from this object, and
   * no lookup into the list by id is ever needed (#1222).
   */
  conversation: ClaudeCodeConversationItem | null;
  /**
   * Its liveness relative to the binding — the header's "Running now" /
   * "Finished". `unknown` means the host could not say, and no claim is drawn.
   */
  activity: ClaudeCodeConversationActivity | null;
  /** The whole conversation as loaded so far, oldest first. */
  items: MessageItems;
  /** Whether older items remain beyond what is loaded. */
  hasMore: boolean;
  /** The transcript ended mid-record; normal for one being appended to. */
  partialTail: boolean;
  /** Records this provider does not model, so the client can say so. */
  skipped: number;
  loading: boolean;
  loadingOlder: boolean;
  /** Older-page pagination failed while readable items remain (#1190). */
  olderError: string | null;
  error: string | null;
}

const EMPTY: MessagesViewState = {
  state: null,
  conversation: null,
  activity: null,
  items: [],
  hasMore: false,
  partialTail: false,
  skipped: 0,
  loading: true,
  loadingOlder: false,
  olderError: null,
  error: null,
};

/**
 * Whether an answer that just arrived is still the one being waited for.
 *
 * Newest-page refresh and older-page pagination use separate generations so a
 * poll cannot drop a valid in-flight older response (#1190).
 */
function stillWanted(
  context: { current: string | null },
  generation: { current: number },
  key: string,
  id: number,
): boolean {
  return context.current === key && generation.current === id;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to load the conversation';
}

/**
 * A page request. `cursor` is absent for the newest page and present for every
 * page after it — that is the only thing that differs between them, so it is the
 * only thing this takes. `conversation_id` is always explicit: it is the only
 * selection mechanism the `messages` unit has (#1222).
 */
function pageRequest(
  agentId: string,
  sessionId: string,
  conversationId: string,
  cursor?: string,
): ClaudeCodeMessagesRequest {
  return {
    agent_id: agentId,
    session_id: sessionId,
    conversation_id: conversationId,
    limit: PAGE_LIMIT,
    ...(cursor ? { cursor } : {}),
  };
}

async function fetchOlderPage({
  agentId,
  sessionId,
  conversationId,
  cursor,
  contextRef,
  olderRequestId,
  positions,
  setMessages,
  key,
  id,
}: {
  agentId: string;
  sessionId: string;
  conversationId: string;
  cursor: string;
  contextRef: { current: string | null };
  olderRequestId: { current: number };
  positions: { current: Positions };
  setMessages: Dispatch<SetStateAction<MessagesViewState>>;
  key: string;
  id: number;
}) {
  setMessages((current) => ({ ...current, loadingOlder: true, olderError: null }));
  try {
    const response = await claudeCodeApi.claudeCodeMessages(
      pageRequest(agentId, sessionId, conversationId, cursor),
    );
    if (!stillWanted(contextRef, olderRequestId, key, id)) {
      return;
    }
    positions.current = withOlderPage(positions.current, response);
    setMessages((current) => ({
      ...current,
      items: itemsOf(positions.current),
      hasMore: hasOlder(positions.current),
      loadingOlder: false,
      olderError: null,
    }));
  } catch (error) {
    if (!stillWanted(contextRef, olderRequestId, key, id)) {
      return;
    }
    setMessages((current) => ({
      ...current,
      loadingOlder: false,
      olderError: message(error),
    }));
  }
}

/**
 * One explicitly named conversation's timeline, paged — the `messages` half of
 * `#1222`.
 *
 * The id is an input, never something this hook finds: `null` means "nothing is
 * open" and nothing is fetched, and a change of id is a different conversation
 * with nothing carried over — not the items, not either cursor. Which items
 * survive a poll, and which cursor "older" continues from, are
 * [`messagePositions`](../model/messagePositions.ts)' business.
 */
export function useMessages({
  agentId,
  sessionId,
  conversationId,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  conversationId: string | null;
}) {
  const [messages, setMessages] = useState<MessagesViewState>(EMPTY);

  /**
   * What a late response must match to still be wanted.
   *
   * `contextKey` changes when the Session or the open conversation does —
   * `#1005` criterion 9 is about the old Session's page arriving after the new
   * one is on screen, and dropping such a response is the whole point.
   * `newestRequestId` and `olderRequestId` are separate so polling does not
   * invalidate an in-flight older page (#1190).
   */
  const contextKey =
    agentId && sessionId && conversationId
      ? `${agentId}:${sessionId}:${conversationId}`
      : null;
  const contextRef = useRef<string | null>(contextKey);
  const newestRequestId = useRef(0);
  const olderRequestId = useRef(0);
  const positions = useRef<Positions>(emptyPositions());

  const fetchNewest = useCallback(
    async (forConversation: string, key: string, id: number) => {
      const response = await claudeCodeApi.claudeCodeMessages(
        pageRequest(agentId as string, sessionId as string, forConversation),
      );
      if (!stillWanted(contextRef, newestRequestId, key, id)) {
        return;
      }
      positions.current = withNewest(positions.current, response);
      setMessages({
        state: response.state,
        conversation: response.conversation ?? null,
        activity: response.activity ?? null,
        items: itemsOf(positions.current),
        hasMore: hasOlder(positions.current),
        partialTail: response.partial_tail,
        skipped: response.skipped,
        loading: false,
        loadingOlder: false,
        olderError: null,
        error:
          response.state === 'error'
            ? (response.error ?? 'The conversation could not be read')
            : null,
      });
    },
    [agentId, sessionId],
  );

  const failNewestIfCurrent = useCallback(
    (key: string, id: number, error: unknown) => {
      if (!stillWanted(contextRef, newestRequestId, key, id)) {
        return;
      }
      setMessages((current) => ({
        ...current,
        loading: false,
        loadingOlder: false,
        error: message(error),
      }));
    },
    [],
  );

  // A Session or conversation change is a different timeline, so nothing about
  // the old one may remain on screen — not the items, not either cursor.
  useEffect(() => {
    contextRef.current = contextKey;
    newestRequestId.current += 1;
    olderRequestId.current += 1;
    const id = newestRequestId.current;
    positions.current = emptyPositions();
    setMessages(EMPTY);
    if (!contextKey || !conversationId) {
      return;
    }
    void fetchNewest(conversationId, contextKey, id).catch((e: unknown) =>
      failNewestIfCurrent(contextKey, id, e),
    );
  }, [contextKey, conversationId, fetchNewest, failNewestIfCurrent]);

  /** Re-read the newest page of whatever is open. */
  const reload = useCallback(() => {
    const key = contextRef.current;
    if (!key || !conversationId) {
      return;
    }
    const id = ++newestRequestId.current;
    void fetchNewest(conversationId, key, id).catch((e: unknown) =>
      failNewestIfCurrent(key, id, e),
    );
  }, [conversationId, failNewestIfCurrent, fetchNewest]);

  /**
   * Re-read the newest page, swallowing a failure.
   *
   * The next tick asks again, and replacing a readable conversation with an
   * error because one tick missed would be a worse answer than a stale one. A
   * failure the user should act on arrives through a load they asked for.
   */
  const poll = useCallback(() => {
    const key = contextRef.current;
    if (!key || !conversationId) {
      return;
    }
    void fetchNewest(conversationId, key, ++newestRequestId.current).catch(() => undefined);
  }, [conversationId, fetchNewest]);

  const loadOlder = useCallback(async () => {
    const key = contextRef.current;
    const cursor = positions.current.cursor;
    if (!key || cursor === null || !agentId || !sessionId || !conversationId) {
      return;
    }
    const id = ++olderRequestId.current;
    await fetchOlderPage({
      agentId,
      sessionId,
      conversationId,
      cursor,
      contextRef,
      olderRequestId,
      positions,
      setMessages,
      key,
      id,
    });
  }, [agentId, conversationId, sessionId]);

  return { messages, reload, loadOlder, poll };
}
