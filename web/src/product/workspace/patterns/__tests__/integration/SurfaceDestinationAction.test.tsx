import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SurfaceDestinationAction } from '@/product/workspace/patterns/SurfaceDestinationAction';

describe('SurfaceDestinationAction (#1204)', () => {
  it('names the destination, not the current surface', () => {
    const { rerender } = render(
      <SurfaceDestinationAction destination="workspace" onOpen={vi.fn()} />,
    );
    expect(
      screen.getByRole('button', { name: 'Open Workspace' }),
    ).toBeInTheDocument();

    rerender(<SurfaceDestinationAction destination="terminal" onOpen={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: 'Open Terminal' }),
    ).toBeInTheDocument();
  });

  it('is icon-only: no state label in the resting visual', () => {
    render(<SurfaceDestinationAction destination="workspace" onOpen={vi.fn()} />);

    const action = screen.getByTestId('surface-action-open-workspace');
    expect(action).not.toHaveTextContent('Workspace');
    expect(action).toHaveAttribute('title', 'Open Workspace');
  });

  it('is a plain button — the retired two-state control left no tab semantics behind', () => {
    render(<SurfaceDestinationAction destination="workspace" onOpen={vi.fn()} />);

    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('matches the capsule/dock chrome band, not the bare control target (#1204)', () => {
    render(<SurfaceDestinationAction destination="workspace" onOpen={vi.fn()} />);

    const action = screen.getByTestId('surface-action-open-workspace');
    expect(action.className).toMatch(/calc\(var\(--control-md\)\+2\*var\(--terminal-capsule-shell-pad-y\)\)/);
  });

  it('restores pointer hit-testing inside a pointer-events-none dock region', () => {
    render(
      <div className="pointer-events-none">
        <SurfaceDestinationAction destination="workspace" onOpen={vi.fn()} />
      </div>,
    );

    expect(screen.getByTestId('surface-action-open-workspace').className).toMatch(
      /pointer-events-auto/,
    );
  });

  it('activates on pointer click', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <div className="pointer-events-none">
        <SurfaceDestinationAction destination="workspace" onOpen={onOpen} />
      </div>,
    );

    await user.click(screen.getByTestId('surface-action-open-workspace'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('projects a capability glyph as a badge when one is supplied (#1347 SC-25)', () => {
    render(
      <SurfaceDestinationAction
        destination="terminal"
        onOpen={vi.fn()}
        glyph={<svg data-testid="glyph-icon" />}
      />,
    );

    const badge = screen.getByTestId('surface-action-glyph');
    expect(badge).toBeInTheDocument();
    expect(screen.getByTestId('glyph-icon')).toBeInTheDocument();
    // Decorative: the badge is hidden from assistive technology, so the
    // action's accessible name stays the destination's.
    expect(badge).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders no badge without a glyph', () => {
    render(<SurfaceDestinationAction destination="terminal" onOpen={vi.fn()} />);

    expect(screen.queryByTestId('surface-action-glyph')).not.toBeInTheDocument();
  });

  it('a projected glyph cannot alter the destination (#1347 SC-26)', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <SurfaceDestinationAction
        destination="terminal"
        onOpen={onOpen}
        glyph={<svg data-testid="glyph-icon" />}
      />,
    );

    const action = screen.getByRole('button', { name: 'Open Terminal' });
    await user.click(action);

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(action).toHaveAttribute('aria-label', 'Open Terminal');
    expect(action).toHaveAttribute('data-testid', 'surface-action-open-terminal');
  });

  it('activates with keyboard (Enter and Space)', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<SurfaceDestinationAction destination="terminal" onOpen={onOpen} />);

    screen.getByTestId('surface-action-open-terminal').focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});
