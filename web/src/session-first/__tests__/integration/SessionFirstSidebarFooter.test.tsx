import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionFirstSidebarFooter } from '@/session-first/SessionFirstSidebarFooter';

vi.mock('@/components/ServerInfoMenu', () => ({
  ServerInfoMenu: () => <div data-testid="server-info-menu" />,
}));

vi.mock('@/lib/sessionFirst', () => ({
  setSessionFirst: vi.fn(),
}));

import { setSessionFirst } from '@/lib/sessionFirst';

describe('SessionFirstSidebarFooter', () => {
  it('shows version info and legacy buttons directly (no overflow menu)', () => {
    render(<SessionFirstSidebarFooter onLegacy={vi.fn()} />);
    expect(screen.getByTestId('server-info-menu')).toBeInTheDocument();
    expect(screen.getByTestId('use-legacy-dashboard')).toBeInTheDocument();
    expect(screen.queryByTestId('session-first-overflow')).not.toBeInTheDocument();
  });

  it('invokes legacy handler and clears session-first preference', async () => {
    const onLegacy = vi.fn();
    render(<SessionFirstSidebarFooter onLegacy={onLegacy} />);
    await userEvent.click(screen.getByTestId('use-legacy-dashboard'));
    expect(onLegacy).toHaveBeenCalledTimes(1);
    expect(setSessionFirst).toHaveBeenCalledWith(false);
  });
});
