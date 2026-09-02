import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionDrawer } from '@/session-first/SessionDrawer';

vi.mock('@/session-first/patterns/SessionList', () => ({
  SessionList: () => <div data-testid="mock-session-list" />,
}));

describe('SessionDrawer', () => {
  it('renders the sessions list when open', () => {
    render(<SessionDrawer open onClose={vi.fn()} sidebar={<div data-testid="mock-sidebar" />} />);
    expect(screen.getByTestId('session-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('mock-sidebar')).toBeInTheDocument();
  });

  it('is hidden when closed', () => {
    render(<SessionDrawer open={false} onClose={vi.fn()} sidebar={null} />);
    expect(screen.queryByTestId('session-drawer')).not.toBeInTheDocument();
  });

  it('closes on scrim click', () => {
    const onClose = vi.fn();
    render(<SessionDrawer open onClose={onClose} sidebar={null} />);
    screen.getByTestId('session-drawer-scrim').click();
    expect(onClose).toHaveBeenCalled();
  });
});
