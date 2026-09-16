import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FixtureShell } from '@/app/fixture/FixtureShell';

vi.mock('@/app/fixture/FixtureTerminal', () => ({
  FixtureTerminal: () => <div data-testid="fixture-terminal" />,
}));

describe('FixtureShell', () => {
  it('renders the deterministic session-first shell with the static terminal', () => {
    render(<FixtureShell />);
    expect(screen.getByTestId('session-first-shell')).toBeInTheDocument();
    // Web has no header at all since #748 — the canonical wide screen is two
    // columns, and identity lives in the sidebar.
    expect(screen.queryByTestId('session-header-line')).not.toBeInTheDocument();
    expect(screen.getByTestId('session-first-sidebar-column')).toBeInTheDocument();
    expect(screen.getByTestId('session-first-main-content')).toBeInTheDocument();
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
    expect(screen.getByTestId('session-first-sidebar-column')).toBeInTheDocument();
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
});
