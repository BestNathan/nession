import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { FixtureWorkspace } from '@/app/fixture/FixtureWorkspace';

/** The fixture reads its observations from the route, so every render needs one. */
function renderFixture(route = '/fixture/workspace') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <FixtureWorkspace />
    </MemoryRouter>,
  );
}

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe('FixtureWorkspace', () => {
  it('renders the workspace shell with the tool bar and files layout', () => {
    renderFixture();
    expect(screen.getByTestId('workspace-shell')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-tool-bar')).toBeInTheDocument();
    expect(screen.getByTestId('files-web-layout')).toBeInTheDocument();
  });

  it('keeps direct chrome to the opened capability and discloses the rest through More', async () => {
    const user = userEvent.setup();
    renderFixture();

    // Files is the opened capability, so it owns the direct slot; registration
    // alone no longer buys a capability permanent navigation.
    expect(screen.getByTestId('workspace-tool-files')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-tool-session')).not.toBeInTheDocument();
    expect(screen.queryByTestId('workspace-tool-agent')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);

    await user.click(screen.getByTestId('workspace-capability-more'));
    expect(await screen.findByTestId('workspace-capability-picker-session')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-capability-picker-agent')).toBeInTheDocument();
  });

  it('gives a capability that is running here a direct slot, marked active', () => {
    renderFixture('/fixture/workspace?pane=claude.exe');

    const entry = screen.getByTestId('workspace-tool-claude-code');
    expect(entry).toHaveAttribute('data-capability-state', 'active');
    // Still bounded: the opened capability plus the one that earned it — the
    // remaining capabilities stay behind More.
    expect(screen.getByTestId('workspace-tool-files')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-tool-session')).not.toBeInTheDocument();
    expect(screen.queryByTestId('workspace-tool-agent')).not.toBeInTheDocument();
  });

  it('keeps a capability that ran here in direct chrome, marked relevant', () => {
    renderFixture('/fixture/workspace?pane=zsh&observed=claude.exe');

    const entry = screen.getByTestId('workspace-tool-claude-code');
    expect(entry).toHaveAttribute('data-capability-state', 'relevant');
    expect(entry).toHaveAttribute('data-capability-presence', 'contextual');
  });

  it('leaves a capability the session never ran in disclosure', () => {
    renderFixture('/fixture/workspace');

    expect(screen.queryByTestId('workspace-tool-claude-code')).not.toBeInTheDocument();
  });

  it('keeps Git out of direct chrome on the canonical route', () => {
    // Presence is earned, not granted: registering Git must not grow the dock,
    // which is also why the golden screenshots do not move.
    renderFixture('/fixture/workspace');

    expect(screen.queryByTestId('workspace-tool-git')).not.toBeInTheDocument();
  });

  it('renders the Git view when the route opens it', async () => {
    renderFixture('/fixture/workspace?capability=git');

    // The stub stands in for the agent, so this is the real view over canned
    // answers — which is what makes the e2e assertions about it meaningful.
    expect(await screen.findByTestId('git-workspace')).toBeInTheDocument();
    // The listing is what the status answer produces; waiting for it is what
    // makes the header assertions below about a resolved state, not a pending one.
    await screen.findByTestId('git-change-list');
    expect(screen.getByTestId('git-branch')).toHaveTextContent('feat/repo-status');
    expect(screen.getByTestId('git-summary')).toHaveTextContent('2 ahead, 1 behind');
  });
});
