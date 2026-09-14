import { describe, expect, it } from 'vitest';
import { resolveWorkspaceCapabilities } from '../../capabilities';
import { WORKSPACE_VIEW_BINDINGS } from '../../viewBindings';
import type { WorkspaceContext } from '../../workspaceContext';

function workspaceContext(): WorkspaceContext {
  return {
    session: null,
    agent: undefined,
    agents: [],
    domain: null,
    fileOps: null,
    experience: 'web',
    onToolChange: () => {},
  };
}

describe('workspace view bindings', () => {
  it('registers each capability id once', () => {
    const ids = WORKSPACE_VIEW_BINDINGS.map((view) => view.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('provides a renderer for both experiences', () => {
    for (const view of WORKSPACE_VIEW_BINDINGS) {
      expect(typeof view.layout.web).toBe('function');
      expect(typeof view.layout.app).toBe('function');
    }
  });

  it('carries no presentation policy', () => {
    // A binding draws a capability; it does not name it, rank it, or decide
    // whether it is available. Name and state come from the provider, placement
    // from Nession's presence policy — so a view cannot grant itself a slot by
    // being added to this list. Widening the key set here means re-arguing that.
    for (const view of WORKSPACE_VIEW_BINDINGS) {
      expect(Object.keys(view).sort()).toEqual(['icon', 'id', 'layout']);
    }
  });

  it('binds only capabilities the workspace actually provides', () => {
    // A binding with no provider renders nothing anywhere, and the failure is
    // silent — the view is simply never reachable. Pairing is the invariant.
    const provided = resolveWorkspaceCapabilities(workspaceContext()).snapshots.map(
      (snapshot) => snapshot.id,
    );

    for (const view of WORKSPACE_VIEW_BINDINGS) {
      expect(provided).toContain(view.id);
    }
  });
});
