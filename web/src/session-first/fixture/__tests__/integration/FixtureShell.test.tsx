import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FixtureShell } from '@/session-first/fixture/FixtureShell';

vi.mock('@/session-first/fixture/FixtureTerminal', () => ({
  FixtureTerminal: () => <div data-testid="fixture-terminal" />,
}));

describe('FixtureShell', () => {
  it('renders the deterministic session-first shell with sessions in the drawer', async () => {
    render(<FixtureShell />);
    expect(screen.getByTestId('session-first-shell')).toBeInTheDocument();
    expect(screen.getByTestId('session-header-line')).toBeInTheDocument();
    expect(screen.getByTestId('session-first-main-content')).toBeInTheDocument();
    expect(screen.getByTestId('fixture-terminal')).toBeInTheDocument();
    expect(screen.getByTestId('server-connection')).toHaveTextContent('server: connected');
    // At rest the sessions list lives in the closed drawer.
    expect(screen.queryByTestId('session-item-row')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('session-first-open-drawer'));
    expect(screen.getByTestId('session-drawer')).toBeInTheDocument();
    expect(screen.getAllByTestId('session-item-row')).toHaveLength(6);
  });

  it('marks exactly one session as selected', async () => {
    render(<FixtureShell />);
    await userEvent.click(screen.getByTestId('session-first-open-drawer'));
    expect(
      screen
        .getAllByTestId('session-item-row')
        .filter((el) => el.getAttribute('data-selected') === 'true'),
    ).toHaveLength(1);
  });
});
