import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionFirstChrome } from '@/session-first/SessionFirstChrome';

describe('SessionFirstChrome', () => {
  it('renders brand and badge without overflow menu', () => {
    render(
      <SessionFirstChrome
        connectionStatus="authenticated"
        error={null}
        clearError={vi.fn()}
      />,
    );
    expect(screen.getByTestId('session-first-chrome')).toBeInTheDocument();
    expect(screen.getByText('Nession')).toBeInTheDocument();
    expect(screen.queryByTestId('session-first-overflow')).not.toBeInTheDocument();
  });

  it('shows dismissible error banner', async () => {
    const clearError = vi.fn();
    render(
      <SessionFirstChrome
        connectionStatus="authenticated"
        error="Something failed"
        clearError={clearError}
      />,
    );

    expect(screen.getByTestId('session-first-error')).toHaveTextContent('Something failed');
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(clearError).toHaveBeenCalledTimes(1);
  });
});
