import { useEffect, useRef, useState } from 'react';
import type { CapabilityState } from '@/product/capability';
import { capsulePeekActionClass } from '@/shared/lib/peekActionClass';
import { claudeCodeApi } from '../ClaudeCodePlugin';
import type { ClaudeCodeConversationResponse, ClaudeCodeListResponse } from '../types';

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
  state,
  onOpenWorkspace,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  state: CapabilityState;
  /**
   * The way in (#1046).
   *
   * This capability's richer surface *is* its Workspace view, so the Signal ends
   * by offering it. Until this requirement the host drew that offer as a generic
   * footer on every Peek; now the capability draws its own, which is also why
   * this one has no Peek — the offer is the whole of its deepening, and a Peek
   * between the Signal and the Workspace would add a step that says nothing.
   */
  onOpenWorkspace?: (resourceId?: string) => void;
}) {
  const { summary } = useProjectConfigCount({ agentId, sessionId });
  const conversation = useConversationTitle({ agentId, sessionId });

  return (
    <div data-testid="claude-code-signal-body" className="flex flex-col gap-1">
      <p className="truncate text-xs font-medium text-foreground">{stateLine(state)}</p>
      <p className="truncate text-xs text-muted-foreground">{detailLine(conversation, summary)}</p>
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
 * `active` is the pane running it right now; `relevant` is that it ran here
 * earlier — the distinction `resolveClaudeCodeState` already draws, said out
 * loud rather than shown as a dot.
 */
function stateLine(state: CapabilityState): string {
  return state === 'active' ? 'Running in this Session' : 'Ran in this Session earlier';
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
function useConversationTitle({
  agentId,
  sessionId,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
}): { title: string | null; hasConversation: boolean } {
  const [state, setState] = useState<{ title: string | null; hasConversation: boolean }>({
    title: null,
    hasConversation: false,
  });
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    const forGeneration = generation.current;
    if (!agentId || !sessionId) {
      setState({ title: null, hasConversation: false });
      return;
    }

    void claudeCodeApi
      .claudeCodeConversation({ agent_id: agentId, session_id: sessionId })
      .then((response: ClaudeCodeConversationResponse) => {
        if (generation.current !== forGeneration) {
          return;
        }
        setState(boundConversation(response));
      })
      .catch(() => {
        if (generation.current !== forGeneration) {
          return;
        }
        setState({ title: null, hasConversation: false });
      });
  }, [agentId, sessionId]);

  return state;
}

/**
 * What a response says about the conversation this Session is bound to.
 *
 * The title is on the **candidate**, not on `conversation`: the identity shape
 * carries an id and a cwd and no display metadata (#1124), so this matches by
 * id — the same join the Workspace header makes.
 */
function boundConversation(response: ClaudeCodeConversationResponse): {
  title: string | null;
  hasConversation: boolean;
} {
  const id = response.conversation?.claude_session_id;
  if (id === undefined) {
    // No binding: `ambiguous` and its neighbours mean a directory full of
    // conversations and no answer about which is this Session's. Saying that
    // much is the Signal's whole budget — choosing one is what `#1005` forbids.
    return { title: null, hasConversation: (response.candidates?.length ?? 0) > 0 };
  }
  const candidate = response.candidates?.find((c) => c.claude_session_id === id);
  const title = candidate?.title?.trim();
  return { title: title ? title : null, hasConversation: true };
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
