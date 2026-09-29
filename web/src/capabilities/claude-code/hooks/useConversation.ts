import { useCallback, useEffect, useRef, useState } from 'react';
import { useConversations, type ConversationBinding } from './useConversations';
import { useMessages } from './useMessages';
import type { MessageItems } from '../model/messagePositions';
import type {
  ClaudeCodeConversationActivity,
  ClaudeCodeConversationItem,
  ClaudeCodeConversationsState,
  ClaudeCodeMessagesState,
} from '../types';

/**
 * How often the newest page is re-read while Claude is running (`#1005`
 * criterion 3: a new turn appears without the user reloading).
 *
 * Polling, not a stream — `#1005` scope 5 allows exactly this for v1, and a
 * stream would need a push protocol this capability does not have. It targets
 * `messages` only (#1222): the timeline is the thing that grows under the
 * reader; the list is re-asked for on an explicit reload, not on a timer.
 */
const POLL_INTERVAL_MS = 3000;

/**
 * What the Workspace view draws, composed from the two units of `#1222`.
 *
 * `listState`/`conversations`/`binding` are the `conversations` unit's answer;
 * `messagesState`/`conversation`/`activity`/`items` and the paging fields are
 * the `messages` unit's. They are kept apart rather than merged into one
 * `state` because they answer different questions and can fail independently —
 * a directory that cannot be read is not a conversation that cannot be, and
 * the view renders them in different places.
 */
export interface ConversationViewState {
  /** The list's own answer. */
  listState: ClaudeCodeConversationsState | null;
  /** What the caller may choose from — the directory's conversations. */
  conversations: ClaudeCodeConversationItem[];
  /** The exact binding, when one is current. */
  binding: ConversationBinding | null;
  /** The open conversation's own answer. */
  messagesState: ClaudeCodeMessagesState | null;
  /**
   * Which conversation is open — the selection, not the response. They agree
   * whenever a read succeeded, and this is the one that is still true when it
   * did not: a `not_found` carries no item, and deriving "open" from the
   * response would silently bounce the reader back to the list with no
   * explanation.
   */
  openId: string | null;
  /** The open conversation — the full item, from the `messages` response. */
  conversation: ClaudeCodeConversationItem | null;
  /** Its liveness: `active` is "Running now", `inactive` is "Finished". */
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
 * This is a composition, not a loader: [`useConversations`](./useConversations.ts)
 * answers "what is here and which one is this Session's" and
 * [`useMessages`](./useMessages.ts) answers "what does this one say". What this
 * hook adds is the one decision that is genuinely the client's —
 *
 * ## What is open
 *
 * An explicit user selection wins; absent one, the **binding** is followed
 * (`#1005` criterion 2's auto-open, in the only form `#1222` allows it: the
 * exact id the provider named, never a guess from a timestamp or a list of
 * one). The selection is tagged with the Session it was made in, so a Session
 * change cannot carry it — the old Session's choice is not a choice here.
 *
 * It also owns the poll: while the open conversation is not known to be
 * finished, keep re-reading its newest page. `inactive` is the one answer
 * that stops the timer — a conversation that has stopped growing does not
 * need to be asked about again — and `unknown` keeps it, because a live
 * conversation frozen on screen is worse than a re-read that changes nothing.
 */
export function useConversation({
  agentId,
  sessionId,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
}) {
  const { list, refresh: refreshList } = useConversations({ agentId, sessionId });
  const contextKey = agentId && sessionId ? `${agentId}:${sessionId}` : null;

  // The user's own choice, tagged with the Session it belongs to. No reset
  // effect is needed: a choice whose tag is not this Session is not a choice.
  const [chosen, setChosen] = useState<{ key: string; id: string } | null>(null);
  const selected = chosen !== null && chosen.key === contextKey ? chosen.id : null;
  const openId = selected ?? list.binding?.conversation_id ?? null;

  const { messages, reload: reloadMessages, loadOlder, poll } = useMessages({
    agentId,
    sessionId,
    conversationId: openId,
  });

  usePoll(poll, messages.state === 'ready' && messages.activity !== 'inactive');

  /** Open a conversation the user chose. `null` returns to the binding. */
  const select = useCallback(
    (conversationId: string | null) => {
      if (!contextKey) {
        return;
      }
      setChosen(conversationId === null ? null : { key: contextKey, id: conversationId });
    },
    [contextKey],
  );

  /** Ask both units again — the list's only refresh, by design (#1222). */
  const reload = useCallback(() => {
    refreshList();
    reloadMessages();
  }, [refreshList, reloadMessages]);

  const view: ConversationViewState = {
    listState: list.state,
    conversations: list.conversations,
    binding: list.binding,
    messagesState: messages.state,
    openId,
    conversation: messages.conversation,
    activity: messages.activity,
    items: messages.items,
    hasMore: messages.hasMore,
    partialTail: messages.partialTail,
    skipped: messages.skipped,
    loading: list.loading || (openId !== null && messages.loading),
    loadingOlder: messages.loadingOlder,
    olderError: messages.olderError,
    error: list.error ?? messages.error,
  };

  return { view, selected: openId, select, reload, loadOlder };
}
