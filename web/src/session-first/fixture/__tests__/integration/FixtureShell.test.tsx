import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FixtureShell } from '@/session-first/fixture/FixtureShell';

vi.mock('@/session-first/fixture/FixtureTerminal', () => ({
  FixtureTerminal: () => <div data-testid="fixture-terminal" />,
}));

describe('FixtureShell', () => {
  it('renders the deterministic session-first shell', () => {
    render(<FixtureShell />);
    expect(screen.getByTestId('session-first-shell')).toBeInTheDocument();
    expect(screen.getAllByTestId('session-item-row')).toHaveLength(6);
    expect(screen.getByTestId('session-first-main-content')).toBeInTheDocument();
    expect(screen.getByTestId('fixture-terminal')).toBeInTheDocument();
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
