import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FixtureApp } from '@/session-first/fixture/FixtureApp';

vi.mock('@/session-first/fixture/FixtureTerminal', () => ({
  FixtureTerminal: () => <div data-testid="fixture-terminal" />,
}));

describe('FixtureApp', () => {
  it('renders the spatial shell with the terminal page active', () => {
    render(<FixtureApp />);
    expect(screen.getByTestId('app-spatial-shell')).toBeInTheDocument();
    // The spatial pager keeps every page mounted — the workspace page's
    // SessionFirstMain renders its own header line, so exactly two exist.
    expect(screen.getAllByTestId('session-header-line')).toHaveLength(2);
    expect(screen.getByTestId('app-header-sessions')).toBeInTheDocument();
    expect(screen.getByTestId('app-header-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-well')).toBeInTheDocument();
    expect(screen.getByTestId('fixture-terminal')).toBeInTheDocument();
  });

  it('navigates to the workspace page via ☰ and back via ←', async () => {
    render(<FixtureApp />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('app-header-workspace'));
    expect(screen.getByTestId('app-tool-header')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-shell')).toBeInTheDocument();
    expect(screen.getByTestId('files-app-layout')).toBeInTheDocument();
    // Surface derives from the pager position: the terminal page is now
    // hidden — proves the pager moved, not just mounted.
    expect(screen.getByTestId('terminal-well').classList.contains('hidden')).toBe(true);
    await user.click(screen.getByTestId('app-tool-back'));
    expect(screen.getByTestId('terminal-well')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-well').classList.contains('hidden')).toBe(false);
  });

  it('opens the sessions page via the header ≡ button', async () => {
    render(<FixtureApp />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('app-header-sessions'));
    expect(screen.getByTestId('session-first-sidebar')).toBeInTheDocument();
    // The sessions page is a pager position, not a surface — the terminal
    // page must stay visible behind it.
    expect(screen.getByTestId('terminal-well').classList.contains('hidden')).toBe(false);
  });
});
