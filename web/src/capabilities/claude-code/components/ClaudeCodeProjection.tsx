import { useEffect, useRef, useState } from 'react';
import type { CapabilityState } from '@/product/capability';
import { capsulePeekActionClass } from '@/shared/lib/peekActionClass';
import { claudeCodeApi } from '../ClaudeCodePlugin';
import type { ClaudeCodeListResponse } from '../types';

/**
 * What Claude Code says in the Terminal.
 *
 * **Signal only — no Peek.** The second implementation, and it is what settled
 * the shape: Git has two Terminal depths because a changed-file list belongs
 * between "3 changed" and a full diff, but Claude Code's richer surface *is*
 * its Workspace view (the config browser). A Peek here would be a summary of a
 * list the Workspace already draws better, so the Signal says what is true and
 * offers the way in.
 *
 * There is no task summary to report: Nession observes the pane's foreground
 * command, not what the agent is doing inside it.
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

  return (
    <div data-testid="claude-code-signal-body" className="flex flex-col gap-1">
      <p className="truncate text-xs font-medium text-foreground">{stateLine(state)}</p>
      <p className="truncate text-xs text-muted-foreground">{summary}</p>
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
