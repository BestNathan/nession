import { useEffect, useRef, useState } from 'react';
import type { CapabilityState } from '@/product/capability';
import type { CapsuleDetail } from '@/product/terminal/capsule/types';
import { claudeCodeApi } from '../ClaudeCodePlugin';
import type {
  ClaudeCodeConversationItem,
  ClaudeCodeConversationsResponse,
} from '../types';
import { ClaudeCodePeek } from './ClaudeCodePeek';

/**
 * What Claude Code says in the Terminal.
 *
 * The Peek is the only body: the Signal it used to be drawn as went with the
 * depth axis. The argument the Signal-only version carried — that Claude Code's
 * richer surface *is* its Workspace view, so a Peek would only summarise a list
 * the Workspace already draws better — was written when the Workspace drew
 * configuration and nothing else. Once the conversation capability landed the
 * comparison stopped being true, and `#1120` returned the capability to the
 * capsule entry in as many words.
 *
 * The line below the state is the conversation's own title when there is one.
 * It used to be only a config count, which answered a question nobody in the
 * Terminal was asking while the pane in front of them was mid-conversation.
 *
 * What Nession still cannot report is what the agent is doing *inside* the
 * pane: it observes the foreground command. The conversation's title is not
 * that — it is read from the transcript, and it is the closest thing to a task
 * summary that exists without inventing one.
 */
export function ClaudeCodeProjection({
  agentId,
  sessionId,
  state,
  onOpenWorkspace,
  openDetail,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  state: CapabilityState;
  /**
   * The host's Workspace routing, for the Peek's content rows.
   *
   * The destination action itself is the host's (#1347 SC-21): this body
   * draws no "Open in Workspace" of its own. What the routing is for is
   * content navigation — a candidate row that opens the conversation it
   * names.
   */
  onOpenWorkspace?: (resourceId?: string) => void;
  /** The host's approved child overlay. Required: the host always offers it. */
  openDetail: (detail: CapsuleDetail) => void;
}) {
  const conversation = useConversationSummary({ agentId, sessionId });

  return (
    <ClaudeCodePeek
      agentId={agentId}
      sessionId={sessionId}
      conversation={conversation}
      state={state}
      onOpenWorkspace={onOpenWorkspace}
      openDetail={openDetail}
    />
  );
}

/**
 * The Session's bound conversation, in the shape the body reads: the title for
 * the line under the state, and the directory's candidates for the rows below.
 *
 * Deliberately **not** `useConversation`. That hook belongs to the Workspace —
 * it pages the transcript, polls a live conversation, and holds selection
 * state. The body wants one answer, once, on a surface that appears and
 * disappears with the capsule; borrowing the heavier hook to read a single
 * string would fetch a page of transcript to do it.
 *
 * A failure is silence rather than a message: the body's job is to say what is
 * true, and the Workspace is where a conversation that cannot be read gets
 * explained and acted on.
 */
function useConversationSummary({
  agentId,
  sessionId,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
}): ConversationSummary {
  const [state, setState] = useState<ConversationSummary>(NO_CONVERSATION);
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    const forGeneration = generation.current;
    if (!agentId || !sessionId) {
      setState(NO_CONVERSATION);
      return;
    }

    void claudeCodeApi
      .claudeCodeConversations({ agent_id: agentId, session_id: sessionId })
      .then((response: ClaudeCodeConversationsResponse) => {
        if (generation.current !== forGeneration) {
          return;
        }
        setState(summarize(response));
      })
      .catch(() => {
        if (generation.current !== forGeneration) {
          return;
        }
        setState(NO_CONVERSATION);
      });
  }, [agentId, sessionId]);

  return state;
}

/**
 * What a response says, in the shape the body reads.
 *
 * The body wants a title for the line under the state, and the directory's
 * candidates for the rows below it, and both come from one answer rather than
 * two requests that could disagree.
 */
export interface ConversationSummary {
  title: string | null;
  /**
   * The provider resolved **one** conversation for this Session, as opposed to
   * there merely being conversations at this cwd.
   *
   * The two are different offers: a bound conversation can be read, while
   * candidates can only be chosen from — and a Peek that said "View
   * conversation" over a directory listing would be promising a transcript it
   * does not have.
   */
  bound: boolean;
  /** What the provider offered, in its own order. The Peek lists these. */
  candidates: Candidate[];
  /** When the bound conversation last moved, for the Peek's recency line. */
  updatedAt: string | null;
}

type Candidate = ClaudeCodeConversationItem;

/** Module-stable, so an absent conversation is one object rather than a new one
 *  per render — the same reason the empty arrays elsewhere are constants. */
const NO_CONVERSATION: ConversationSummary = {
  title: null,
  bound: false,
  candidates: [],
  updatedAt: null,
};

/**
 * What a `conversations` response says about the conversation this Session is
 * bound to.
 *
 * The binding carries the id and the activity and no display metadata, so the
 * title is read off the item it names — the one id-join the `conversations`
 * unit is *for*. (The Workspace header needs no such join: `messages` answers
 * with the full item, #1222.)
 */
function summarize(response: ClaudeCodeConversationsResponse): ConversationSummary {
  if (response.state !== 'ready') {
    // A directory that cannot be read is silence on this surface, the same as
    // a failure to ask — the Workspace is where that gets explained.
    return NO_CONVERSATION;
  }
  const candidates = response.items ?? [];
  const binding = response.binding;

  if (!binding) {
    // No binding: a directory full of conversations and no answer about which
    // is this Session's. Saying that much is all the body may do — there is no
    // `ambiguous` to render anymore, because the list *is* the answer (#1222),
    // and choosing one is what `#1005` forbids.
    return { ...NO_CONVERSATION, candidates };
  }

  // The binding names the item; the display metadata lives on the item itself.
  // It can be paged out of this response (the binding is computed from the
  // provider's full list, before pagination) — then there is a bound
  // conversation and nothing more to say about it here.
  const bound = candidates.find((c) => c.id === binding.conversation_id);
  const title = bound?.title?.trim();
  return {
    title: title ? title : null,
    bound: true,
    candidates,
    updatedAt: bound?.updated_at ?? null,
  };
}
