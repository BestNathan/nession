import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
    }> = {},
  ) {
    return render(
      <AppSpatialShell
        sessions={<div>sessions-content</div>}
        terminal={<div>terminal-content</div>}
        workspace={<div>workspace-content</div>}
        index={overrides.index ?? 1}
        onIndexChange={onIndexChange}
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

  it('never puts Sessions/Workspace navigation on the terminal page', () => {
    renderShell({ index: 1 });

    // Navigation belongs to the App header (`app-header-sessions` /
    // `app-header-workspace`). The terminal page used to carry a duplicate
    // pair of overlay icon buttons behind a `showHeaderActions` prop that no
    // caller ever set — #748 §6 read them as a shipped feature. They are gone;
    // this assertion is what stops them growing back onto the work surface.
    expect(screen.queryByTestId('app-spatial-open-sessions')).not.toBeInTheDocument();
    expect(screen.queryByTestId('app-spatial-open-workspace')).not.toBeInTheDocument();
  });
});
