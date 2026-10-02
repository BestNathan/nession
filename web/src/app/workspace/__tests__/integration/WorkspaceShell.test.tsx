import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceShell } from '@/app/workspace/WorkspaceShell';
import { SurfaceDestinationAction } from '@/product/workspace/patterns/SurfaceDestinationAction';
import type { WorkspaceContext } from '@/app/workspace/workspaceContext';

// The Web experience's Files layout is stubbed rather than the whole binding:
// a binding is now assembled in `viewBindings.ts` from an id, an icon and the
// two experiences' layouts, so there is no single object left to swap out.
vi.mock('@/app/experiences/web/FilesWebLayout', () => ({
  FilesWebLayout: () => <div data-testid="mock-files-web" />,
}));

// The App half is stubbed for the same reason: the surface-navigation tests
// below render the App experience, and the real App Files layout opens a
// directory listing against the stub `fileOps` on mount.
vi.mock('@/app/experiences/app/FilesAppLayout', () => ({
  FilesAppLayout: () => <div data-testid="mock-files-app" />,
}));

function workspaceContext(overrides: Partial<WorkspaceContext> = {}): WorkspaceContext {
  return {
    session: {
      session_id: 'agent-1:work',
      agent_id: 'agent-1',
      session_name: 'work',
    } as never,
    agent: { agent_id: 'agent-1' } as never,
    agents: [{ agent_id: 'agent-1' } as never],
    domain: null,
    fileOps: {} as never,
    experience: 'web',
    onToolChange: vi.fn(),
    ...overrides,
  };
}

describe('WorkspaceShell contextual capability presentation', () => {
  it('renders all capabilities in the scrollable capsule', () => {
    const ctx = workspaceContext();
    render(<WorkspaceShell ctx={ctx} activeCapabilityId="files" />);

    expect(screen.getByTestId('mock-files-web')).toBeInTheDocument();
    // Capsule V2 (#1347): Workspace capsule shows ALL capabilities (scrollable).
    // This is the reciprocal of Terminal, which shows only the active capability.
    expect(screen.getByTestId('workspace-tool-files')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-tool-session')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-tool-agent')).toBeInTheDocument();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    // Capsule V2 (#1347): no + button in Workspace — all capabilities are
    // directly visible in the scrollable capsule.
    expect(
      screen.queryByRole('button', { name: 'More workspace capabilities' }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('workspace-tool-bar')).toHaveAttribute(
      'data-navigation-mode',
      'contextual',
    );
  });

  // Capsule V2 (#1347): discoverable capabilities are no longer shown in Workspace.
  // They are accessed through Work Overview in Terminal form. Removed tests that
  // validated the disclosure menu behavior.

  it('does not advertise unavailable capabilities in direct chrome', () => {
    const ctx = workspaceContext({ fileOps: null });

    render(<WorkspaceShell ctx={ctx} activeCapabilityId="session" />);
    expect(screen.queryByTestId('workspace-tool-files')).not.toBeInTheDocument();
    // Capsule V2: no disclosure menu, so no need to test what it contains.
  });

  it('keeps an unavailable opened capability stable instead of switching arbitrarily', () => {
    const ctx = workspaceContext({ fileOps: null });

    render(<WorkspaceShell ctx={ctx} activeCapabilityId="files" />);

    expect(screen.queryByTestId('mock-files-web')).not.toBeInTheDocument();
    expect(screen.getByTestId('workspace-capability-unavailable')).toHaveTextContent(
      'Files is not available here',
    );
    expect(screen.queryByTestId('workspace-tool-files')).not.toBeInTheDocument();
  });

  // Capsule V2 (#1347): Claude Code discoverability through disclosure menu removed.
  // Discoverable capabilities are now accessed through Work Overview in Terminal form.
});

describe('WorkspaceShell surface navigation (#1204)', () => {
  const openTerminal = (
    <SurfaceDestinationAction destination="terminal" onOpen={() => {}} />
  );

  it('renders the surface action beside — not inside — the capability capsule', () => {
    const ctx = workspaceContext();
    render(
      <WorkspaceShell ctx={ctx} activeCapabilityId="files" surfaceAction={openTerminal} />,
    );

    const surfaceNav = screen.getByTestId('workspace-surface-navigation');
    expect(surfaceNav).toContainElement(screen.getByTestId('surface-action-open-terminal'));
    // Capsule V2 (#1347): reciprocal layout — surface navigation (circle) left,
    // capability capsule right. They are separate axes.
    expect(
      screen.getByRole('navigation', { name: 'Workspace capabilities' }),
    ).not.toContainElement(screen.getByTestId('surface-action-open-terminal'));
    // …and it precedes the capsule, so the group reads [Terminal ○] [capsule].
    expect(
      surfaceNav.compareDocumentPosition(
        screen.getByRole('navigation', { name: 'Workspace capabilities' }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('keeps the surface action when a pushed depth hides the capability dock', () => {
    const ctx = workspaceContext();
    render(
      <WorkspaceShell
        ctx={ctx}
        activeCapabilityId="files"
        pushed
        surfaceAction={openTerminal}
      />,
    );

    expect(screen.queryByRole('navigation', { name: 'Workspace capabilities' })).not.toBeInTheDocument();
    expect(screen.getByTestId('surface-action-open-terminal')).toBeInTheDocument();
  });

  it('renders no surface navigation for the App experience', () => {
    const ctx = workspaceContext({ experience: 'app' });
    render(
      <WorkspaceShell ctx={ctx} activeCapabilityId="files" surfaceAction={openTerminal} />,
    );

    expect(screen.queryByTestId('workspace-surface-navigation')).not.toBeInTheDocument();
    // The dock itself is unaffected.
    expect(screen.getByTestId('workspace-tool-files')).toBeInTheDocument();
  });
});
