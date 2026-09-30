import { useEffect, useRef, useState } from 'react';
import type { CapabilityState } from '@/product/capability';
import type { CapsuleDetail } from '@/product/terminal/capsule/types';
import { capsulePeekActionClass } from '@/shared/lib/peekActionClass';
import { claudeCodeApi } from '../ClaudeCodePlugin';
import { stateLine } from '../model/stateLine';
import type {
  ClaudeCodeConversationItem,
  ClaudeCodeConversationsResponse,
  ClaudeCodeListResponse,
} from '../types';
import { ClaudeCodePeek } from './ClaudeCodePeek';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';

/**
 * What Claude Code says in the Terminal.
 *
 * **Signal only, for now — and the reason it was Signal-only no longer holds.**
 *
 * The original argument was that Claude Code's richer surface *is* its Workspace
 * view, so a Peek would only summarise a list the Workspace already draws
 * better. That was written when the Workspace drew configuration and nothing
 * else. Once the conversation capability landed the comparison stopped being
 * true, and `#1120` overturns it in as many words — Claude Code is to gain a
 * real Peek and return to the capsule entry. This file is still Signal-only
 * because the Peek has not been built yet, not because the question is open.
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
  depth,
  state,
  onOpenWorkspace,
  openDetail,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  /**
   * Which depth this body is drawn at.
   *
   * The host decided this before mounting — `#1046` was explicit that a body
   * able to change it would be a second, weaker copy of that decision — so this
   * reads it and draws, rather than holding a depth of its own.
   */
  depth: 'signal' | 'peek';
  state: CapabilityState;
  /**
   * The way in (#1046).
   *
   * Supplied by the host and drawn by the capability, at both depths: whether
   * there is somewhere deeper to go, and what that looks like, is this
   * capability's answer rather than a footer every Peek inherits.
   */
  onOpenWorkspace?: (resourceId?: string) => void;
  /** The host's approved child overlay. Required: the host always offers it. */
  openDetail: (detail: CapsuleDetail) => void;
}) {
  const { summary } = useProjectConfigCount({ agentId, sessionId });
  const conversation = useConversationSummary({ agentId, sessionId });

  if (depth === 'peek') {
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

  return (
    <div data-testid="claude-code-signal-body" className="flex flex-col gap-1">
      <p className={cn('truncate text-foreground', chromeSansRole('metadata'))}>{stateLine(state)}</p>
      <p className={cn('truncate text-muted-foreground', chromeSansRole('caption'))}>{detailLine(conversation, summary)}</p>
      {onOpenWorkspace ? (
        <div className="flex justify-end">
          <button
            type="button"
            data-testid="capsule-capability-open-workspace"
            onClick={() => onOpenWorkspace()}
            className={capsulePeekActionClass}
          >
            Open in Workspace →
          </button>
        </div>
      ) : null}
    </div>
  );
}


/**
 * The line under the state, ordered by how much it says.
 *
 * The conversation's own title first, then the fact that a conversation exists
 * at all, and only then the config count — which is a fact about the repository
 * rather than about the work (#1120). The count is not dropped: it is what is
 * left to say when the Session is running Claude Code with nothing readable yet,
 * and a Signal that said nothing there would be indistinguishable from a broken
 * one.
 */
function detailLine(
  conversation: { title: string | null; hasConversation: boolean },
  configSummary: string,
): string {
  if (conversation.title !== null) {
    return conversation.title;
  }
  if (conversation.hasConversation) {
    return 'Conversation available';
  }
  return configSummary;
}

/**
 * The Session's bound conversation, as far as the Signal needs it: a title, and
 * whether there is one at all.
 *
 * Deliberately **not** `useConversation`. That hook belongs to the Workspace —
 * it pages the transcript, polls a live conversation, and holds selection
 * state. The Signal wants one answer, once, on a surface that appears and
 * disappears with the capsule; borrowing the heavier hook to read a single
 * string would fetch a page of transcript to do it.
 *
 * A failure is silence rather than a message. The Signal's job is to say what is
 * true, and the Workspace is where a conversation that cannot be read gets
 * explained and acted on — the same rule the config summary already follows.
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
 * What a response says, in the shape **both** depths read.
 *
 * The Signal wants one line and the Peek wants the recency and the directory's
 * other candidates, so they read one answer rather than making the same request
 * twice — they are one surface at two depths, and a second fetch would be the
 * first place they could disagree.
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
  hasConversation: boolean;
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
  hasConversation: false,
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
    // is this Session's. Saying that much is all either depth may do — there
    // is no `ambiguous` to render anymore, because the list *is* the answer
    // (#1222), and choosing one is what `#1005` forbids.
    return { ...NO_CONVERSATION, hasConversation: candidates.length > 0, candidates };
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
    hasConversation: true,
    candidates,
    updatedAt: bound?.updated_at ?? null,
  };
}

/**
 * How much project config this Session's repository has.
 *
 * The one fact the Terminal can report that the user has not already got from
 * the pane in front of them. Fetched at the project scope because that is the
 * half tied to the work at hand; the global half belongs to the machine, not
 * this Session.
 */
function useProjectConfigCount({
  agentId,
  sessionId,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
}): { summary: string } {
  const [summary, setSummary] = useState('Reading project config…');
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    const forGeneration = generation.current;
    if (!agentId || !sessionId) {
      setSummary('');
      return;
    }

    void claudeCodeApi
      .claudeCodeList({ agent_id: agentId, scope: 'project', session_id: sessionId })
      .then((response: ClaudeCodeListResponse) => {
        if (generation.current !== forGeneration) {
          return;
        }
        setSummary(describeConfig(response));
      })
      .catch(() => {
        if (generation.current !== forGeneration) {
          return;
        }
        // A Signal that cannot report says nothing rather than reporting a
        // failure: the config browser is where that gets explained and acted on.
        setSummary('');
      });
  }, [agentId, sessionId]);

  return { summary };
}

function describeConfig(response: ClaudeCodeListResponse): string {
  if (!response.available) {
    return 'Not installed on this host';
  }
  const files = response.categories.reduce((total, category) => total + category.files.length, 0);
  if (files === 0) {
    return 'No project config';
  }
  return `${files} project config ${files === 1 ? 'file' : 'files'}`;
}
