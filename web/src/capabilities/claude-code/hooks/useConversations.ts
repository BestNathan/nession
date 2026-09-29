import { useCallback, useEffect, useRef, useState } from 'react';
import { claudeCodeApi } from '../ClaudeCodePlugin';
import type {
  ClaudeCodeConversationItem,
  ClaudeCodeConversationsResponse,
  ClaudeCodeConversationsState,
} from '../types';

/**
 * The exact Nession↔Claude binding, as the `conversations` unit reports it
 * (#1222). A relationship, not a property of any item: it names the one
 * conversation this Session is bound to, and how live that binding is.
 */
export type ConversationBinding = NonNullable<ClaudeCodeConversationsResponse['binding']>;

/**
 * Ask for up to the provider's own item ceiling rather than its smaller
 * default page, so the list the user chooses from is the whole directory in
 * the common case. The provider clamps; it does not error.
 */
const LIST_LIMIT = 200;

export interface ConversationsListState {
  /** The provider's own word for what it could answer. */
  state: ClaudeCodeConversationsState | null;
  /** The directory's conversations, newest first — the list to choose from. */
  conversations: ClaudeCodeConversationItem[];
  /** The exact binding, when one is current. What auto-open follows. */
  binding: ConversationBinding | null;
  loading: boolean;
  error: string | null;
}

const EMPTY: ConversationsListState = {
  state: null,
  conversations: [],
  binding: null,
  loading: true,
  error: null,
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to list the conversations';
}

/**
 * The conversations visible at one Session's cwd, and the exact binding.
 *
 * Fetched when the Session changes and when the caller asks again — and not on
 * a timer: `#1222` puts polling on `messages` only, because the list is the
 * answer to "what is here", not a thing that grows under the reader. A new
 * conversation or a moved binding is one `refresh` away, and the Workspace's
 * own reload is what asks.
 *
 * There is no selection logic here and there cannot be: the unit resolves
 * nothing, so an unbound session is a list the caller has not chosen from yet
 * — never an ambiguity to repair with a heuristic.
 */
export function useConversations({
  agentId,
  sessionId,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
}) {
  const [list, setList] = useState<ConversationsListState>(EMPTY);
  const contextKey = agentId && sessionId ? `${agentId}:${sessionId}` : null;
  const contextRef = useRef<string | null>(contextKey);
  const requestId = useRef(0);

  const fetchList = useCallback(
    async (key: string, id: number) => {
      const response = await claudeCodeApi.claudeCodeConversations({
        agent_id: agentId as string,
        session_id: sessionId as string,
        limit: LIST_LIMIT,
      });
      if (contextRef.current !== key || requestId.current !== id) {
        return;
      }
      setList({
        state: response.state,
        conversations: response.items ?? [],
        binding: response.binding ?? null,
        loading: false,
        error:
          response.state === 'error'
            ? (response.error ?? 'The conversations could not be listed')
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

  // A Session change is a different directory, so nothing about the old one may
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

  /** Ask again — the only refresh the list gets, by design (#1222). */
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
