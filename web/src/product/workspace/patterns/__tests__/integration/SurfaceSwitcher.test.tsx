import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SurfaceSwitcher } from '@/product/workspace/patterns/SurfaceSwitcher';

function renderFloatingPlacement(
  surface: 'terminal' | 'workspace',
  onSurfaceChange: (surface: 'terminal' | 'workspace') => void,
) {
  return render(
    <div className="pointer-events-none">
      <SurfaceSwitcher surface={surface} onSurfaceChange={onSurfaceChange} />
    </div>,
  );
}

describe('SurfaceSwitcher', () => {
  it('restores pointer hit-testing on the interactive capsule (#1168)', () => {
    const onSurfaceChange = vi.fn();
    renderFloatingPlacement('terminal', onSurfaceChange);

    expect(screen.getByTestId('surface-switcher').className).toMatch(/pointer-events-auto/);
  });

  it('shows icon + label on the active surface and icon-only on the inactive entry (#1169)', () => {
    const { rerender } = render(
      <SurfaceSwitcher surface="terminal" onSurfaceChange={vi.fn()} />,
    );

    expect(screen.getByTestId('surface-switcher-terminal')).toHaveTextContent('Terminal');
    expect(screen.getByTestId('surface-switcher-workspace')).not.toHaveTextContent('Workspace');

    rerender(<SurfaceSwitcher surface="workspace" onSurfaceChange={vi.fn()} />);

    expect(screen.getByTestId('surface-switcher-workspace')).toHaveTextContent('Workspace');
    expect(screen.getByTestId('surface-switcher-terminal')).not.toHaveTextContent('Terminal');
  });

  it('switches surfaces on pointer click through a pointer-events-none placement wrapper', async () => {
    const user = userEvent.setup();
    const onSurfaceChange = vi.fn();
    renderFloatingPlacement('terminal', onSurfaceChange);

    await user.click(screen.getByTestId('surface-switcher-workspace'));
    expect(onSurfaceChange).toHaveBeenCalledWith('workspace');
  });

  it('does not call onSurfaceChange when the active segment is clicked again', async () => {
    const user = userEvent.setup();
    const onSurfaceChange = vi.fn();
    render(<SurfaceSwitcher surface="terminal" onSurfaceChange={onSurfaceChange} />);

    await user.click(screen.getByTestId('surface-switcher-terminal'));
    expect(onSurfaceChange).not.toHaveBeenCalled();
  });

  it('switches surfaces with keyboard activation', async () => {
    const user = userEvent.setup();
    const onSurfaceChange = vi.fn();
    render(<SurfaceSwitcher surface="terminal" onSurfaceChange={onSurfaceChange} />);

    const workspace = screen.getByTestId('surface-switcher-workspace');
    workspace.focus();
    await user.keyboard('{Enter}');
    expect(onSurfaceChange).toHaveBeenCalledWith('workspace');
  });
});
