import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FixtureShell } from '@/app/fixture/FixtureShell';

vi.mock('@/app/fixture/FixtureTerminal', () => ({
  FixtureTerminal: () => <div data-testid="fixture-terminal" />,
}));

describe('FixtureShell', () => {
  it('renders the deterministic shell with the static terminal', () => {
    render(<FixtureShell />);
    expect(screen.getByTestId('shell')).toBeInTheDocument();
    // Web has no header at all since #748 — the canonical wide screen is two
    // columns, and identity lives in the sidebar.
    expect(screen.queryByTestId('session-header-line')).not.toBeInTheDocument();
    expect(screen.getByTestId('sidebar-column')).toBeInTheDocument();
    expect(screen.getByTestId('main-content')).toBeInTheDocument();
    expect(screen.getByTestId('fixture-terminal')).toBeInTheDocument();
    // Canonical fixture is healthy: nothing to alarm about.
    expect(screen.queryByTestId('server-connection')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-context')).not.toBeInTheDocument();
    expect(screen.queryByTestId('connection-status')).not.toBeInTheDocument();
  });

  it('renders the sessions sidebar column deterministically', () => {
    // Above `lg` the sidebar is a column, not an overlay drawer (#748): the
    // drawer-open state this fixture used to force is not one the shipped shell
    // has at this width, so the canonical screen moved with the shell.
    render(<FixtureShell />);
    expect(screen.getByTestId('sidebar-column')).toBeInTheDocument();
    expect(screen.queryByTestId('session-drawer')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('session-item-row')).toHaveLength(6);
  });

  it('marks exactly one session as selected', () => {
    render(<FixtureShell />);
    expect(
      screen
        .getAllByTestId('session-item-row')
        .filter((el) => el.getAttribute('data-selected') === 'true'),
    ).toHaveLength(1);
  });

  it('lists Projects and opens a standalone detail without losing the selected Session', async () => {
    const user = userEvent.setup();
    render(<FixtureShell />);

    const projects = await screen.findAllByTestId('project-item-row');
    expect(projects).toHaveLength(2);
    expect(screen.getByTestId('projects-section')).toBeInTheDocument();

    await user.click(projects[0]);
    expect(await screen.findByTestId('project-detail')).toBeInTheDocument();
    expect(screen.getByTestId('project-detail-title')).toHaveTextContent('Nession');
    // The Session selection (and therefore the return target) survives the
    // Project destination even though Web replaces the main region.
    expect(
      screen
        .getAllByTestId('session-item-row')
        .filter((el) => el.getAttribute('data-selected') === 'true'),
    ).toHaveLength(1);

    const sessionRow = screen.getAllByTestId('session-item-row')[0];
    await user.click(within(sessionRow).getAllByRole('button')[0]);
    expect(screen.queryByTestId('project-detail')).not.toBeInTheDocument();
    expect(await screen.findByTestId('fixture-terminal')).toBeInTheDocument();
    expect(screen.queryByTestId('project-detail')).not.toBeInTheDocument();
  });

  it('keeps Projects reachable with zero Sessions', async () => {
    window.location.hash = '#/fixture?sessions=none&selection=none';
    try {
      render(<FixtureShell />);
      expect(await screen.findAllByTestId('project-item-row')).toHaveLength(2);
      expect(screen.getByTestId('projects-section')).toBeInTheDocument();
      expect(screen.queryAllByTestId('session-item-row')).toHaveLength(0);
    } finally {
      window.location.hash = '';
    }
  });
});
