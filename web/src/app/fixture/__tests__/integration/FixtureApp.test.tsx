import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FixtureApp } from '@/app/fixture/FixtureApp';

vi.mock('@/app/fixture/FixtureTerminal', () => ({
  FixtureTerminal: () => <div data-testid="fixture-terminal" />,
}));

describe('FixtureApp', () => {
  it('renders the Terminal root with neither layer mounted', () => {
    render(<FixtureApp />);
    expect(screen.getByTestId('app-layer-root')).toHaveAttribute(
      'data-layer',
      'terminal',
    );
    // Exactly one header line. The pager mounted all three pages at once, so a
    // second one used to exist permanently; that duplicate is what this
    // composition removes, and a regression would bring it back.
    expect(screen.getAllByTestId('session-header-line')).toHaveLength(1);
    expect(screen.getByTestId('app-header-sessions')).toBeInTheDocument();
    expect(screen.getByTestId('app-header-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-well')).toBeInTheDocument();
    expect(screen.getByTestId('fixture-terminal')).toBeInTheDocument();
    expect(screen.queryByTestId('app-layer-workspace')).toBeNull();
    expect(screen.queryByTestId('app-layer-sessions')).toBeNull();
  });

  it('opens Workspace as a layer and returns to the same Terminal', async () => {
    render(<FixtureApp />);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('app-header-workspace'));
    expect(screen.getByTestId('app-layer-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('app-tool-header')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-shell')).toBeInTheDocument();
    expect(screen.getByTestId('files-app-layout')).toBeInTheDocument();
    // The Terminal stays mounted underneath rather than being translated
    // off-screen. That is the mechanism behind #1049's "returning restores the
    // same Terminal state": there is no unmount, so there is no rebuild.
    expect(screen.getByTestId('app-layer-terminal')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-well')).toBeInTheDocument();

    await user.click(screen.getByTestId('app-tool-back'));
    expect(screen.queryByTestId('app-layer-workspace')).toBeNull();
    expect(screen.getByTestId('terminal-well')).toBeInTheDocument();
  });

  it('opens Sessions as a layer and leaves the surface at the Terminal', async () => {
    render(<FixtureApp />);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('app-header-sessions'));
    expect(screen.getByTestId('app-layer-sessions')).toBeInTheDocument();
    // The App's own Sessions surface, not `Sidebar` (#1050 stage 1).
    expect(screen.getByTestId('app-sessions-surface')).toBeInTheDocument();
    // Sessions is navigation, not a surface — the Terminal remains the surface
    // and stays visible behind the layer. The old test recorded the same intent
    // as "a pager position, not a surface"; the overlay model is what makes it
    // literally true instead of a consequence of which page happened to mount.
    expect(screen.getByTestId('app-layer-terminal')).toBeInTheDocument();
    expect(
      screen.getByTestId('terminal-well').classList.contains('hidden'),
    ).toBe(false);
  });
});
