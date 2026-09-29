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
