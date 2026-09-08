import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionFirstSidebarFooter } from '@/app/SessionFirstSidebarFooter';

vi.mock('@/features/server/components/ServerInfoMenu', () => ({
  ServerInfoMenu: () => <div data-testid="server-info-menu" />,
}));

describe('SessionFirstSidebarFooter', () => {
  it('shows the server info row directly (no overflow menu, no legacy switch)', () => {
    render(<SessionFirstSidebarFooter />);
    expect(screen.getByTestId('server-info-menu')).toBeInTheDocument();
    expect(screen.queryByTestId('session-first-overflow')).not.toBeInTheDocument();
    expect(screen.queryByTestId('use-legacy-dashboard')).not.toBeInTheDocument();
  });
});
