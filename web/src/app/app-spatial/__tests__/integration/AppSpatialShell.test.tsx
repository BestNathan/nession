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

  it('does not render overlay navigation buttons by default', () => {
    renderShell({ index: 1 });

    expect(screen.queryByTestId('app-spatial-open-sessions')).not.toBeInTheDocument();
    expect(screen.queryByTestId('app-spatial-open-workspace')).not.toBeInTheDocument();
  });
});
