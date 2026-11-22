import { useCallback, useState } from 'react';
import { copyToClipboard } from '@/shared/lib/clipboard';
import type { WorkspaceDepthControl } from '@/app/workspace/workspaceContext';
import type { ClaudeCodeMcpEntry } from '../../types';
import {
  CLAUDE_ROOT_ANCESTOR,
  type AppRoute,
  type McpEditorIntent,
  routeKey,
  routeTitle,
} from './model';
import { useClaudeAppChrome } from './useClaudeAppChrome';
import { useClaudeAppContextReset } from './useClaudeAppContextReset';

/**
 * The pushed stack and its recorded forward history, updated together.
 *
 * One object rather than two `useState`s: every transition that pushes or pops
 * also decides what the forward history becomes, and a state updater must stay
 * pure. Keeping them atomic is what makes "never enter an unknown resource by
 * gesture" a property of the data rather than an ordering convention.
 */
interface AppNavigationState {
  stack: AppRoute[];
  forward: AppRoute[];
}

const EMPTY_NAVIGATION: AppNavigationState = { stack: [], forward: [] };

/**
 * The App composition's navigation state.
 *
 * It owns the pushed stack, the recorded forward history, the one Browse sheet,
 * the MCP write dialogs, and the registrations the shell needs: the current
 * depth (title, truthful ancestry, Back label, leave/jump actions), the
 * capability-local header actions, and the forward destination an inner swipe
 * may use. Keeping them here means the screen components only draw, and a
 * Session/Agent switch has one place to retire everything that belonged to the
 * previous provider space.
 *
 * Forward history exists only for depths the user actually left (#3971). A new
 * push, a Browse selection or a context change clears it, so a left swipe can
 * never enter a resource the capability did not record.
 */
export function useClaudeAppNavigation({
  agentId,
  sessionId,
  depth,
  titleOf = (route) => routeTitle(route),
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  depth: WorkspaceDepthControl;
  /** The resource's own name for the header; falls back to the route kind. */
  titleOf?: (route: AppRoute) => string;
}) {
  const [navigation, setNavigation] = useState<AppNavigationState>(EMPTY_NAVIGATION);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [mcpEditor, setMcpEditor] = useState<McpEditorIntent | null>(null);
  const [mcpRemoving, setMcpRemoving] = useState<ClaudeCodeMcpEntry | null>(null);
  const { stack, forward: forwardStack } = navigation;
  const top = stack.length > 0 ? stack[stack.length - 1] : null;
  const contextKey = agentId && sessionId ? `${agentId}:${sessionId}` : null;

  // A Session/Agent change is a different provider space. The open transcript
  // is already reset by the shared hook; this drops the resource stack, the
  // forward history and the write dialogs so no pushed detail, pending
  // mutation or stale forward destination survives the switch.
  const resetForContext = useCallback(() => {
    setNavigation(EMPTY_NAVIGATION);
    setBrowseOpen(false);
    setMcpEditor(null);
    setMcpRemoving(null);
  }, []);
  useClaudeAppContextReset(contextKey, resetForContext);

  // Leaving a depth records it as the forward destination. `recordForward` is
  // false for an invalidation repair, where the depth no longer exists and
  // must not become a gesture target.
  const popDepth = useCallback((recordForward: boolean) => {
    setNavigation((current) => {
      if (current.stack.length === 0) {
        return current;
      }
      const leaving = current.stack[current.stack.length - 1];
      return {
        stack: current.stack.slice(0, -1),
        forward: recordForward ? [leaving, ...current.forward] : current.forward,
      };
    });
  }, []);

  const pop = useCallback(() => popDepth(true), [popDepth]);
  const retireTop = useCallback(() => popDepth(false), [popDepth]);

  const push = useCallback((route: AppRoute) => {
    setNavigation((current) => ({
      stack: [...current.stack, route],
      forward: [],
    }));
  }, []);
  const forward = useCallback(() => {
    setNavigation((current) => {
      const next = current.forward[0];
      if (next === undefined) {
        return current;
      }
      return {
        stack: [...current.stack, next],
        forward: current.forward.slice(1),
      };
    });
  }, []);

  // Choosing from the sheet replaces the pushed stack: the sheet is a resource
  // index, so its answer is a resource root and Back returns to the work.
  const openResource = useCallback((route: AppRoute) => {
    setBrowseOpen(false);
    setNavigation({ stack: [route], forward: [] });
  }, []);

  // Ancestor jump runs the same leave semantics as Back (#3971): the depths
  // above the ancestor become forward history, and the guard contract stays
  // the capability's (Claude App is read-only, so there is no dirty state).
  const jumpToAncestor = useCallback((id: string) => {
    setNavigation((current) => {
      if (id === CLAUDE_ROOT_ANCESTOR.id) {
        if (current.stack.length === 0) {
          return current;
        }
        return { stack: [], forward: [...current.stack, ...current.forward] };
      }
      const index = current.stack.findIndex((route) => routeKey(route) === id);
      if (index < 0) {
        return current;
      }
      const above = current.stack.slice(index + 1);
      return {
        stack: current.stack.slice(0, index + 1),
        forward: [...above, ...current.forward],
      };
    });
  }, []);

  const openBrowse = useCallback(() => setBrowseOpen(true), []);
  const copyReference = useCallback(() => {
    void copyToClipboard(top === null ? 'claude:current-conversation' : `${top.kind}:${routeKey(top)}`);
  }, [top]);
  const nextForward = forwardStack[0] ?? null;
  useClaudeAppChrome({
    agentId,
    sessionId,
    depth,
    top,
    stack,
    nextForward,
    titleOf,
    pop,
    forward,
    jumpToAncestor,
    openBrowse,
    copyReference,
  });

  const openCandidate = useCallback((id: string) => push({ kind: 'conversation', id }), [push]);
  const openTranscript = useCallback((id: string) => push({ kind: 'transcript', id }), [push]);

  return {
    top,
    stack,
    browseOpen,
    setBrowseOpen,
    push,
    pop,
    retireTop,
    forward,
    openCandidate,
    openTranscript,
    openResource,
    jumpToAncestor,
    mcpEditor,
    setMcpEditor,
    mcpRemoving,
    setMcpRemoving,
  };
}
