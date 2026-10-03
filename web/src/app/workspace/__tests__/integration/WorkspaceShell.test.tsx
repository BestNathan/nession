import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceShell } from '@/app/workspace/WorkspaceShell';
import { SurfaceDestinationAction } from '@/product/workspace/patterns/SurfaceDestinationAction';
import { CapsuleExchangeContext } from '@/platform/motion/capsuleExchange';
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

  it('renders entries in registration order, marking the active one in place', () => {
    // Owner follow-up (2026-10-03): activation is not placement. The opened
    // capability keeps its registration position and is only marked — the row
    // does not reshuffle itself under the reader's thumb as the work changes.
    const ctx = workspaceContext();
    render(<WorkspaceShell ctx={ctx} activeCapabilityId="env" />);

    const slots = [
      ...screen
        .getByTestId('workspace-capability-scroll')
        .querySelectorAll('button[data-testid^="workspace-tool-"]'),
    ].map((entry) => entry.getAttribute('data-testid'));

    expect(slots).toEqual([
      'workspace-tool-files',
      'workspace-tool-session',
      'workspace-tool-agent',
      'workspace-tool-env',
      'workspace-tool-claude-code',
      'workspace-tool-git',
    ]);
    const env = screen.getByTestId('workspace-tool-env');
    expect(env).toHaveAttribute('data-capability-active', 'true');
    expect(env).toHaveAttribute('aria-pressed', 'true');
  });

  it('labels every entry under its icon', () => {
    const ctx = workspaceContext();
    render(<WorkspaceShell ctx={ctx} activeCapabilityId="files" />);

    expect(screen.getByTestId('workspace-tool-files-label')).toHaveTextContent('Files');
    expect(screen.getByTestId('workspace-tool-claude-code-label')).toHaveTextContent(
      'Claude Code',
    );
  });

  it('arrives with the capsule exchange while a swipe carries the layer in', () => {
    // The incoming half of the App handoff (see `capsuleExchange`): mid-swipe
    // the bar trails the finger's pace and fades in; at rest there is no
    // exchange and the bar carries no inline style at all.
    const ctx = workspaceContext();
    const { rerender } = render(<WorkspaceShell ctx={ctx} activeCapabilityId="files" />);
    expect(screen.getByTestId('workspace-tool-bar').getAttribute('style')).toBeNull();

    rerender(
      <CapsuleExchangeContext.Provider value={{ progress: 0.5 }}>
        <WorkspaceShell ctx={ctx} activeCapabilityId="files" />
      </CapsuleExchangeContext.Provider>,
    );
    const bar = screen.getByTestId('workspace-tool-bar');
    expect(bar).toHaveAttribute('data-capsule-exchange', 'arriving');
    expect(bar.style.transform).toBe('translateX(14px)');
    expect(bar.style.opacity).toBe('0.5');
    expect(bar.style.pointerEvents).toBe('none');
  });

  // Capsule V2 (#1347): discoverable capabilities are no longer shown in Workspace.
  // They are accessed through Work Overview in Terminal form. Removed tests that
  // validated the disclosure menu behavior.

  it('keeps an unavailable capability in the row, greyed rather than dropped', () => {
    const ctx = workspaceContext({ fileOps: null });

    render(<WorkspaceShell ctx={ctx} activeCapabilityId="session" />);

    // Membership must not change under the reader as the work changes, so the
    // entry stays and is drawn inert instead. `disabled-foreground` is the role
    // the design system defines for a control the user cannot act with — held
    // to the 3:1 that keeps it from disappearing, not to AA.
    const files = screen.getByTestId('workspace-tool-files');
    expect(files).toHaveAttribute('data-capability-state', 'unavailable');
    expect(files).toBeDisabled();
    expect(files.className).toContain('text-disabled-foreground');
  });

  it('keeps an unavailable opened capability stable instead of switching arbitrarily', () => {
    const ctx = workspaceContext({ fileOps: null });

    render(<WorkspaceShell ctx={ctx} activeCapabilityId="files" />);

    expect(screen.queryByTestId('mock-files-web')).not.toBeInTheDocument();
    expect(screen.getByTestId('workspace-capability-unavailable')).toHaveTextContent(
      'Files is not available here',
    );
    // The row still carries it, inert — the view refused to switch, and the
    // reader can see which capability they are sitting on and why.
    expect(screen.getByTestId('workspace-tool-files')).toHaveAttribute(
      'data-capability-state',
      'unavailable',
    );
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

  it('keeps both the surface action and the capsule — the shell has no depth gate', () => {
    // Owner decision 2026-10-03, superseding #1051's dock rule: the capsule is
    // present at every Workspace depth, so the shell takes no `pushed` prop and
    // there is no state in which this row renders without it. The surface
    // action sits beside it, unchanged.
    const ctx = workspaceContext();
    render(<WorkspaceShell ctx={ctx} activeCapabilityId="files" surfaceAction={openTerminal} />);

    expect(
      screen.getByRole('navigation', { name: 'Workspace capabilities' }),
    ).toBeInTheDocument();
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
