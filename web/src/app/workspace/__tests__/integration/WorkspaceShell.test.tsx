import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  it('renders only the opened capability directly and progressively discloses the rest', () => {
    const ctx = workspaceContext();
    render(<WorkspaceShell ctx={ctx} activeCapabilityId="files" />);

    expect(screen.getByTestId('mock-files-web')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-tool-files')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-tool-session')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(
      screen.getByRole('button', { name: 'More workspace capabilities' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('workspace-tool-bar')).toHaveAttribute(
      'data-navigation-mode',
      'contextual',
    );
  });

  it('puts available capabilities in More and invokes the selected deeper view', async () => {
    const user = userEvent.setup();
    const onToolChange = vi.fn();
    const ctx = workspaceContext({ onToolChange });

    render(<WorkspaceShell ctx={ctx} activeCapabilityId="files" />);
    await user.click(screen.getByRole('button', { name: 'More workspace capabilities' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Agent' }));

    expect(onToolChange).toHaveBeenCalledWith('agent');
  });

  it('does not advertise unavailable capabilities in direct chrome or More', async () => {
    const user = userEvent.setup();
    const ctx = workspaceContext({ fileOps: null });

    render(<WorkspaceShell ctx={ctx} activeCapabilityId="session" />);
    expect(screen.queryByTestId('workspace-tool-files')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'More workspace capabilities' }));
    // The menu mounts a tick after the click, so the negative assertion has to
    // wait for a positive one first — otherwise "not advertised" would also
    // pass on a menu that never opened.
    expect(await screen.findByRole('menuitem', { name: 'Agent' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Files' })).not.toBeInTheDocument();
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

  it('keeps Claude Code discoverable through its direct capability provider', async () => {
    const user = userEvent.setup();
    const onToolChange = vi.fn();
    const ctx = workspaceContext({ onToolChange });

    render(<WorkspaceShell ctx={ctx} activeCapabilityId="session" />);
    await user.click(screen.getByRole('button', { name: 'More workspace capabilities' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Claude Code' }));

    expect(onToolChange).toHaveBeenCalledWith('claude-code');
  });
});

describe('WorkspaceShell surface navigation (#1204)', () => {
  const openTerminal = (
    <SurfaceDestinationAction destination="terminal" onOpen={() => {}} />
  );

  it('renders the surface action beside — not inside — the capability dock', () => {
    const ctx = workspaceContext();
    render(
      <WorkspaceShell ctx={ctx} activeCapabilityId="files" surfaceAction={openTerminal} />,
    );

    const surfaceNav = screen.getByTestId('workspace-surface-navigation');
    expect(surfaceNav).toContainElement(screen.getByTestId('surface-action-open-terminal'));
    // Surface navigation and capability navigation are separate axes: the
    // circle is adjacent to the dock, never an entry in it.
    expect(
      screen.getByRole('navigation', { name: 'Workspace capabilities' }),
    ).not.toContainElement(screen.getByTestId('surface-action-open-terminal'));
    // …and it precedes the dock, so the group reads [Terminal ○] [dock].
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
