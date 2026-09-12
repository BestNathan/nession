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
    expect(screen.getByTestId('session-header-line')).toBeInTheDocument();
    expect(screen.getByTestId('session-first-main-content')).toBeInTheDocument();
    expect(screen.getByTestId('fixture-terminal')).toBeInTheDocument();
    // Canonical fixture is healthy: identity + navigation only.
    expect(screen.queryByTestId('server-connection')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-context')).not.toBeInTheDocument();
    expect(screen.queryByTestId('connection-status')).not.toBeInTheDocument();
  });

  it('renders the sessions drawer deterministically', () => {
    render(<FixtureShell />);
    expect(screen.getByTestId('session-drawer')).toBeInTheDocument();
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
