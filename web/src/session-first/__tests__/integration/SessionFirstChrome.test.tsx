import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionFirstChrome } from '@/session-first/SessionFirstChrome';

vi.mock('@/components/ServerInfoMenu', () => ({
  ServerInfoMenu: () => <div data-testid="server-info-menu" />,
}));

describe('SessionFirstChrome', () => {
  it('renders thin chrome with overflow for Env and Legacy', async () => {
    const onOpenEnv = vi.fn();
    const onLegacy = vi.fn();
    render(
      <SessionFirstChrome
        connectionStatus="authenticated"
        error={null}
        clearError={vi.fn()}
        onOpenEnv={onOpenEnv}
        onLegacy={onLegacy}
      />,
    );
    expect(screen.getByTestId('session-first-chrome')).toBeInTheDocument();
    expect(screen.getByText('Nession')).toBeInTheDocument();
    expect(screen.queryByTestId('session-first-env')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('session-first-overflow'));
    await userEvent.click(await screen.findByTestId('session-first-env'));
    expect(onOpenEnv).toHaveBeenCalled();
  });

  it('shows dismissible error banner', async () => {
    const clearError = vi.fn();
    render(
      <SessionFirstChrome
        connectionStatus="authenticated"
        error="Something failed"
        clearError={clearError}
        onOpenEnv={vi.fn()}
        onLegacy={vi.fn()}
      />,
    );

    expect(screen.getByTestId('session-first-error')).toHaveTextContent('Something failed');
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(clearError).toHaveBeenCalledTimes(1);
  });
});
