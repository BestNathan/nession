import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceDepthControl } from '@/app/workspace/workspaceContext';
import { CLAUDE_CODE_TITLE } from '../../identity';
import type { ClaudeCodeMcpEntry } from '../../types';
import { type AppRoute, type McpEditorIntent, routeTitle } from './model';

/**
 * The App composition's navigation state.
 *
 * It owns the pushed stack, the one Browse sheet, the MCP write dialogs, and
 * the two registrations the shell needs: the current depth (title, Back label,
 * leave action) and the capability-local header action. Keeping them here
 * means the screen components only draw, and a Session/Agent switch has one
 * place to retire everything that belonged to the previous provider space.
 */
export function useClaudeAppNavigation({
  agentId,
  sessionId,
  depth,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  depth: WorkspaceDepthControl;
}) {
  const [stack, setStack] = useState<AppRoute[]>([]);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [mcpEditor, setMcpEditor] = useState<McpEditorIntent | null>(null);
  const [mcpRemoving, setMcpRemoving] = useState<ClaudeCodeMcpEntry | null>(null);

  const top = stack.length > 0 ? stack[stack.length - 1] : null;
  const contextKey = agentId && sessionId ? `${agentId}:${sessionId}` : null;
  const previousContext = useRef(contextKey);

  // A Session/Agent change is a different provider space. The open transcript
  // is already reset by the shared hook; this drops the resource stack and the
  // write dialogs so no pushed detail or pending mutation survives the switch.
  useEffect(() => {
    if (previousContext.current === contextKey) {
      return;
    }
    previousContext.current = contextKey;
    setStack([]);
    setBrowseOpen(false);
    setMcpEditor(null);
    setMcpRemoving(null);
  }, [contextKey]);

  const pop = useCallback(() => {
    setStack((current) => current.slice(0, -1));
  }, []);

  // The page header is the shell's; the capability declares the depth and what
  // leaving it means (#1051). The label names the depth Back returns to, which
  // for the first push is the capability itself.
  useEffect(() => {
    if (top === null) {
      depth.setPush(null);
      return;
    }
    const below = stack.length > 1 ? stack[stack.length - 2] : null;
    depth.setPush({
      title: routeTitle(top),
      backLabel: `Back to ${below === null ? CLAUDE_CODE_TITLE : routeTitle(below)}`,
      onLeave: pop,
    });
  }, [depth, pop, stack, top]);

  // Browse is capability-local navigation, not a leave: it stays available at
  // every depth, so the user can switch resources without unwinding the stack
  // first. The shell draws the control; this supplies the action.
  useEffect(() => {
    if (!agentId || !sessionId) {
      depth.setAction?.(null);
      return;
    }
    depth.setAction?.({
      label: 'Browse',
      ariaLabel: 'Browse Claude',
      onActivate: () => setBrowseOpen(true),
    });
  }, [agentId, depth, sessionId]);

  // The capability unmounts with its layer stack; neither the depth nor the
  // header action may outlive it.
  useEffect(
    () => () => {
      depth.setPush(null);
      depth.setAction?.(null);
    },
    [depth],
  );

  const push = useCallback((route: AppRoute) => {
    setStack((current) => [...current, route]);
  }, []);

  // Choosing from the sheet replaces the pushed stack: the sheet is a resource
  // index, so its answer is a resource root and Back returns to the work.
  const openResource = useCallback((route: AppRoute) => {
    setBrowseOpen(false);
    setStack([route]);
  }, []);

  const openCandidate = useCallback(
    (id: string) => push({ kind: 'conversation', id }),
    [push],
  );
  const openTranscript = useCallback(
    (id: string) => push({ kind: 'transcript', id }),
    [push],
  );

  return {
    top,
    stack,
    browseOpen,
    setBrowseOpen,
    push,
    pop,
    openResource,
    openCandidate,
    openTranscript,
    mcpEditor,
    setMcpEditor,
    mcpRemoving,
    setMcpRemoving,
  };
}
