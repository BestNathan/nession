import { useEffect, useLayoutEffect } from 'react';
import type { ClaudeCodeWorkspaceState } from '../../hooks/useClaudeCodeWorkspace';
import { resourceOfRoute, transcriptIdOf, type AppRoute } from './model';

/**
 * Mirrors the App's route stack into the shared hook's three inputs.
 *
 * The stack is the only navigation source; the shared hook needs to know which
 * resource is visible (so Memory/MCP fetch lazily), which transcript is open
 * (so its records follow the pushed depth), and whether an MCP server is still
 * selected (so the server depth cannot outlive its selection).
 */
export function useClaudeAppSync(
  state: ClaudeCodeWorkspaceState,
  top: AppRoute | null,
  pop: () => void,
) {
  const { setActiveView, openTranscript, setOpenTranscript, mcp } = state;
  const { selection, clearSelection, inventory } = mcp;

  // The visible resource is also the shared hook's lazy-fetch trigger.
  useEffect(() => {
    setActiveView(resourceOfRoute(top));
  }, [setActiveView, top]);

  // A pushed record or Raw reads the same transcript the depth below it does.
  const openTranscriptId = transcriptIdOf(top);
  useEffect(() => {
    if (openTranscript !== openTranscriptId) {
      setOpenTranscript(openTranscriptId);
    }
  }, [openTranscript, openTranscriptId, setOpenTranscript]);

  // A server's identity is the pushed route; entering the MCP root always
  // means the server list, so a selection left from an earlier visit is
  // retired rather than silently re-opening a detail. Layout phase: the list
  // must be what the browser paints after Back, not a frame of the detail the
  // user just left.
  useLayoutEffect(() => {
    if (top?.kind === 'mcp' && selection !== null) {
      clearSelection();
    }
  }, [clearSelection, selection, top]);

  // The reverse direction: if the selected server disappears (the inventory
  // was reloaded), the server depth has nothing to show and returns to the
  // list.
  useEffect(() => {
    if (top?.kind === 'mcp-server' && inventory !== null && selection === null) {
      pop();
    }
  }, [inventory, pop, selection, top]);
}
