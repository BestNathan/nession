import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { claudeCodeApi } from '../ClaudeCodePlugin';
import {
  emptyPositions,
  hasOlder,
  itemsOf,
  withNewest,
  withOlderPage,
  type Positions,
} from '../model/conversationPositions';
import type {
  ClaudeCodeConversationRequest,
  ClaudeCodeConversationResponse,
  ClaudeCodeConversationState,
} from '../types';

/**
 * How often the newest page is re-read while Claude is running (`#1005`
 * criterion 3: a new turn appears without the user reloading).
 *
 * Polling, not a stream — `#1005` scope 5 allows exactly this for v1, and a
 * stream would need a push protocol this capability does not have. Slow enough
 * that a long tool call is not re-read dozens of times, fast enough that a
 * finished turn lands while the user is still looking at the pane.
 */
const POLL_INTERVAL_MS = 3000;

/** How many items one page asks for. The provider clamps this to its ceiling. */
const PAGE_LIMIT = 60;

export interface ConversationViewState {
  /** The provider's own word for what it could resolve. */
  state: ClaudeCodeConversationState | null;
  /** Set when a conversation was resolved. */
  conversation: ClaudeCodeConversationResponse['conversation'];
  /** What the caller may choose from — populated even when one was resolved. */
  candidates: NonNullable<ClaudeCodeConversationResponse['candidates']>;
  /** The whole conversation as loaded so far, oldest first. */
  items: NonNullable<ClaudeCodeConversationResponse['items']>;
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

const EMPTY: ConversationViewState = {
  state: null,
  conversation: null,
  candidates: [],
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
 * only thing this takes.
 */
function pageRequest(
  agentId: string,
  sessionId: string,
  claudeSessionId: string | null,
  cursor?: string,
): ClaudeCodeConversationRequest {
  return {
    agent_id: agentId,
    session_id: sessionId,
    limit: PAGE_LIMIT,
    ...(claudeSessionId ? { claude_session_id: claudeSessionId } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

async function fetchOlderPage({
  agentId,
  sessionId,
  selected,
  cursor,
  contextRef,
  olderRequestId,
  positions,
  setView,
  key,
  id,
}: {
  agentId: string;
  sessionId: string;
  selected: string | null;
  cursor: string;
  contextRef: { current: string | null };
  olderRequestId: { current: number };
  positions: { current: Positions };
  setView: Dispatch<SetStateAction<ConversationViewState>>;
  key: string;
  id: number;
}) {
  setView((current) => ({ ...current, loadingOlder: true, olderError: null }));
  try {
    const response = await claudeCodeApi.claudeCodeConversation(
      pageRequest(agentId, sessionId, selected, cursor),
    );
    if (!stillWanted(contextRef, olderRequestId, key, id)) {
      return;
    }
    positions.current = withOlderPage(positions.current, response);
    setView((current) => ({
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
    setView((current) => ({
      ...current,
      loadingOlder: false,
      olderError: message(error),
    }));
  }
}

function useSessionConversationReset({
  contextKey,
  contextRef,
  newestRequestId,
  olderRequestId,
  positions,
  setSelected,
  setView,
  fetchNewest,
  failNewestIfCurrent,
}: {
  contextKey: string | null;
  contextRef: { current: string | null };
  newestRequestId: { current: number };
  olderRequestId: { current: number };
  positions: { current: Positions };
  setSelected: Dispatch<SetStateAction<string | null>>;
  setView: Dispatch<SetStateAction<ConversationViewState>>;
  fetchNewest: (claudeSessionId: string | null, key: string, id: number) => Promise<void>;
  failNewestIfCurrent: (key: string, id: number, error: unknown) => void;
}) {
  // A Session change is a different conversation, so nothing about the old one
  // may remain on screen — not the items, not the selection, not either cursor.
  useEffect(() => {
    contextRef.current = contextKey;
    newestRequestId.current += 1;
    olderRequestId.current += 1;
    const id = newestRequestId.current;
    positions.current = emptyPositions();
    setSelected(null);
    setView(EMPTY);
    if (!contextKey) {
      return;
    }
    void fetchNewest(null, contextKey, id).catch((e: unknown) => failNewestIfCurrent(contextKey, id, e));
  }, [
    contextKey,
    contextRef,
    failNewestIfCurrent,
    fetchNewest,
    newestRequestId,
    olderRequestId,
    positions,
    setSelected,
    setView,
  ]);
}

/**
 * Loads a conversation, and knows which answers are still wanted.
 *
 * ## It never chooses a conversation
 *
 * With no selection the request carries no `claude_session_id`, and the provider
 * answers with the conversation this Session is **bound** to — or `ambiguous`
 * plus the candidates. That is the whole mechanism of "auto-open on an exact
 * binding" (`#1005` criterion 2): the decision belongs to the side that holds
 * the binding, and this hook has no path that could reproduce it from a
 * timestamp. A list of one is still a list, and stays one.
 *
 * Which items survive a poll, and which cursor "older" continues from, are
 * [`conversationPositions`](../model/conversationPositions.ts)' business.
 *
 * Split from [`useConversation`] so the polling lives with the view's own state
 * rather than with the loading: this half never has to know when it is being
 * polled.
 */
function useConversationLoader({
  agentId,
  sessionId,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
}) {
  const [view, setView] = useState<ConversationViewState>(EMPTY);
  const [selected, setSelected] = useState<string | null>(null);

  /**
   * What a late response must match to still be wanted.
   *
   * `contextKey` changes when the Session changes — criterion 9 is about the old
   * Session's page arriving after the new one is on screen, and dropping such a
   * response is the whole point. `newestRequestId` and `olderRequestId` are
   * separate so polling does not invalidate an in-flight older page (#1190).
   */
  const contextKey = agentId && sessionId ? `${agentId}:${sessionId}` : null;
  const contextRef = useRef<string | null>(contextKey);
  const newestRequestId = useRef(0);
  const olderRequestId = useRef(0);
  const positions = useRef<Positions>(emptyPositions());

  const fetchNewest = useCallback(
    async (claudeSessionId: string | null, key: string, id: number) => {
      const response = await claudeCodeApi.claudeCodeConversation(
        pageRequest(agentId as string, sessionId as string, claudeSessionId),
      );
      if (!stillWanted(contextRef, newestRequestId, key, id)) {
        return;
      }
      positions.current = withNewest(positions.current, response);
      setView({
        state: response.state,
        conversation: response.conversation ?? null,
        candidates: response.candidates ?? [],
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
      setView((current) => ({ ...current, loading: false, loadingOlder: false, error: message(error) }));
    },
    [],
  );

  useSessionConversationReset({
    contextKey,
    contextRef,
    newestRequestId,
    olderRequestId,
    positions,
    setSelected,
    setView,
    fetchNewest,
    failNewestIfCurrent,
  });

  /** Re-read the newest page, keeping whatever the user has open. */
  const reload = useCallback(() => {
    if (!contextKey) {
      return;
    }
    const id = ++newestRequestId.current;
    void fetchNewest(selected, contextKey, id).catch((e: unknown) => failNewestIfCurrent(contextKey, id, e));
  }, [contextKey, failNewestIfCurrent, fetchNewest, selected]);

  /**
   * Re-read the newest page, swallowing a failure.
   *
   * The next tick asks again, and replacing a readable conversation with an
   * error because one tick missed would be a worse answer than a stale one. A
   * failure the user should act on arrives through a load they asked for.
   */
  const poll = useCallback(() => {
    const key = contextRef.current;
    if (!key) {
      return;
    }
    void fetchNewest(selected, key, ++newestRequestId.current).catch(() => undefined);
  }, [fetchNewest, selected]);

  const loadOlder = useCallback(async () => {
    const key = contextRef.current;
    const cursor = positions.current.cursor;
    if (!key || cursor === null || !agentId || !sessionId) {
      return;
    }
    const id = ++olderRequestId.current;
    await fetchOlderPage({
      agentId,
      sessionId,
      selected,
      cursor,
      contextRef,
      olderRequestId,
      positions,
      setView,
      key,
      id,
    });
  }, [agentId, selected, sessionId]);

  /** Open a conversation the user chose. `null` asks for the bound one again. */
  const select = useCallback(
    (claudeSessionId: string | null) => {
      if (!contextKey) {
        return;
      }
      setSelected(claudeSessionId);
      const id = ++newestRequestId.current;
      olderRequestId.current += 1;
      positions.current = emptyPositions();
      setView((current) => ({
        ...current,
        items: [],
        state: null,
        loading: true,
        error: null,
        olderError: null,
      }));
      void fetchNewest(claudeSessionId, contextKey, id).catch((e: unknown) => failNewestIfCurrent(contextKey, id, e));
    },
    [contextKey, failNewestIfCurrent, fetchNewest],
  );

  return { view, selected, reload, loadOlder, select, poll };
}

/**
 * `useEffect` + `setInterval`, without re-arming on every render.
 *
 * `onTick` is held in a ref: a caller that passes an inline arrow would
 * otherwise restart the timer each render, and a conversation that re-arms its
 * poll every time it re-renders is one that never actually polls on schedule.
 */
function usePoll(onTick: () => void, enabled: boolean) {
  const tick = useRef(onTick);
  tick.current = onTick;
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const timer = window.setInterval(() => tick.current(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [enabled]);
}

/**
 * The conversation open in the Claude Code capability's Workspace view.
 *
 * Adds the one thing the loader deliberately does not do: while Claude is
 * running, keep re-reading the newest page (`#1005` criterion 3). Only `ready` —
 * `inactive` means Claude has finished, and a conversation that has stopped
 * growing does not need to be asked about again. The other states are not
 * conversations at all.
 */
export function useConversation({
  agentId,
  sessionId,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
}) {
  const { view, selected, reload, loadOlder, select, poll } = useConversationLoader({
    agentId,
    sessionId,
  });
  usePoll(poll, view.state === 'ready');
  return { view, selected, reload, loadOlder, select };
}
