import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AppSpatialShell,
  type SpatialPageIndex,
} from '../../AppSpatialShell';

describe('AppSpatialShell', () => {
  const onIndexChange = vi.fn<(index: SpatialPageIndex) => void>();

  beforeEach(() => {
    onIndexChange.mockClear();
  });

  function renderShell(
    overrides: Partial<{
      index: SpatialPageIndex;
      showHeaderActions: boolean;
    }> = {},
  ) {
    return render(
      <AppSpatialShell
        sessions={<div>sessions-content</div>}
        terminal={<div>terminal-content</div>}
        workspace={<div>workspace-content</div>}
        index={overrides.index ?? 1}
        onIndexChange={onIndexChange}
        showHeaderActions={overrides.showHeaderActions ?? true}
      />,
    );
  }

  it('renders shell and three page testids when index is 1', () => {
    renderShell({ index: 1 });

    expect(screen.getByTestId('app-spatial-shell')).toBeInTheDocument();
    expect(screen.getByTestId('app-spatial-page-sessions')).toBeInTheDocument();
    expect(screen.getByTestId('app-spatial-page-terminal')).toBeInTheDocument();
    expect(screen.getByTestId('app-spatial-page-workspace')).toBeInTheDocument();
  });

  it('clicking open-sessions calls onIndexChange(0); open-workspace calls 2', async () => {
    const user = userEvent.setup();
    renderShell({ index: 1, showHeaderActions: true });

    await user.click(screen.getByTestId('app-spatial-open-sessions'));
    expect(onIndexChange).toHaveBeenCalledWith(0);

    onIndexChange.mockClear();

    await user.click(screen.getByTestId('app-spatial-open-workspace'));
    expect(onIndexChange).toHaveBeenCalledWith(2);
  });
});
