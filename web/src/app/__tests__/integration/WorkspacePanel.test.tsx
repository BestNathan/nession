import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspacePanel } from '@/app/WorkspacePanel';
import type { DomainState } from '@/product/session/model/domainState';
import type { WorkspaceDepthControl } from '@/app/workspace/workspaceContext';
import type { Session } from '@/types';

/**
 * The depth control `WorkspacePanel` hands the capability's view. Captured from
 * the stubbed shell so a test can drive a push the way a capability does —
 * `FilesAppLayout` calls `depth.setPush` from an effect, and this is the same
 * call, without needing a real file tree to get there.
 */
const captured = vi.hoisted(() => ({
  depth: null as WorkspaceDepthControl | null,
  surfaceAction: null as React.ReactNode,
}));

vi.mock('@/app/workspace/WorkspaceShell', () => ({
  WorkspaceShell: ({
    depth,
    surfaceAction,
  }: {
    depth?: WorkspaceDepthControl;
    surfaceAction?: React.ReactNode;
  }) => {
    captured.depth = depth ?? null;
    captured.surfaceAction = surfaceAction ?? null;
    return <div data-testid="stub-workspace-shell" />;
  },
}));

const sess: Session = {
  session_id: 'a1:fix',
  agent_id: 'a1',
  session_name: 'Fix terminal reconnect',
  status: 'active',
  window_count: 1,
  attached_clients: 0,
  last_activity: new Date().toISOString(),
};

const domain: DomainState = {
  agent: { channel: 'online', copy: null },
  session: { channel: 'active', copy: null },
  attachment: { channel: 'attached', copy: null },
};

function renderPanel(onDepthChange = vi.fn()) {
  const view = render(
    <WorkspacePanel
      selectedSession={sess}
      selectedAgent={undefined}
      agents={[]}
      domain={domain}
      surface="workspace"
      tool="files"
      fileOps={null}
      experience="app"
      facts={undefined}
      onSurfaceChange={vi.fn()}
      onToolChange={vi.fn()}
      onDepthChange={onDepthChange}
    />,
  );
  return { view, onDepthChange };
}

/** Declare a pushed depth, exactly as a capability's effect does. */
function push(depth: WorkspaceDepthControl | null, onLeave = vi.fn()) {
  act(() => {
    depth?.setPush({ title: 'App.tsx', onLeave });
  });
  return onLeave;
}

describe('WorkspacePanel — the pushed depth is reported upward (#1081)', () => {
  it('reports no detail at the capability root', () => {
    const { onDepthChange } = renderPanel();
    expect(onDepthChange).toHaveBeenLastCalledWith(false);
  });

  it('reports a detail once a capability declares one', () => {
    // The hop the whole #1081 suppression rests on: the pager stands down on
    // the strength of this flag, so a panel that never reported would leave
    // every other test green while the shell kept discarding unsaved editors.
    const { onDepthChange } = renderPanel();
    expect(captured.depth).not.toBeNull();

    push(captured.depth);

    expect(onDepthChange).toHaveBeenLastCalledWith(true);
  });

  it('reports the root again when the capability pops', () => {
    const { onDepthChange } = renderPanel();
    push(captured.depth);

    act(() => {
      captured.depth?.setPush(null);
    });

    expect(onDepthChange).toHaveBeenLastCalledWith(false);
  });

  it('reports no detail once the panel is gone', () => {
    // The Workspace layer unmounts whenever it is closed. A stale `true` would
    // silence the Terminal's own gesture — the flag outlives the panel
    // otherwise, because the App keeps one composition while layers come and go.
    const { view, onDepthChange } = renderPanel();
    push(captured.depth);

    view.unmount();

    expect(onDepthChange).toHaveBeenLastCalledWith(false);
  });

  it('is inert when nobody is listening', () => {
    // Web renders this panel with no `onDepthChange` at all — it has no
    // top-level gesture to suppress.
    expect(() =>
      render(
        <WorkspacePanel
          selectedSession={sess}
          selectedAgent={undefined}
          agents={[]}
          domain={domain}
          surface="workspace"
          tool="files"
          fileOps={null}
          experience="web"
          facts={undefined}
          onSurfaceChange={vi.fn()}
          onToolChange={vi.fn()}
        />,
      ),
    ).not.toThrow();
  });
});

describe('WorkspacePanel — the Terminal-return circle projects the active conversation (#1347 SC-25)', () => {
  function renderWebPanel(foregroundCommand: string | null) {
    render(
      <WorkspacePanel
        selectedSession={{ ...sess, foreground_command: foregroundCommand }}
        selectedAgent={undefined}
        agents={[]}
        domain={domain}
        surface="workspace"
        tool="files"
        fileOps={null}
        experience="web"
        facts={undefined}
        onSurfaceChange={vi.fn()}
        onToolChange={vi.fn()}
      />,
    );
    // The stubbed shell hands the action back; render what the panel resolved.
    return render(<>{captured.surfaceAction}</>);
  }

  it('shows the capability glyph while the pane runs a Claude Code command', () => {
    const view = renderWebPanel('claude.exe');

    expect(view.getByTestId('surface-action-glyph')).toBeInTheDocument();
    // …inside the Terminal-return circle, destination untouched (SC-26).
    expect(view.getByTestId('surface-action-open-terminal')).toBeInTheDocument();
  });

  it('shows no glyph when the pane runs something else', () => {
    const view = renderWebPanel('bash');

    expect(view.queryByTestId('surface-action-glyph')).not.toBeInTheDocument();
    expect(view.getByTestId('surface-action-open-terminal')).toBeInTheDocument();
  });
});
