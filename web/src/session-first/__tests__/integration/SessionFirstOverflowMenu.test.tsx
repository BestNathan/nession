import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionFirstOverflowMenu } from '@/session-first/SessionFirstOverflowMenu';

vi.mock('@/components/ServerInfoMenu', () => ({
  ServerInfoMenu: () => <div data-testid="server-info-menu" />,
}));

describe('SessionFirstOverflowMenu', () => {
  it('opens menu and invokes Env / Legacy', async () => {
    const onOpenEnv = vi.fn();
    const onLegacy = vi.fn();
    render(
      <SessionFirstOverflowMenu onOpenEnv={onOpenEnv} onLegacy={onLegacy} />,
    );
    await userEvent.click(screen.getByTestId('session-first-overflow'));
    await userEvent.click(screen.getByTestId('session-first-env'));
    expect(onOpenEnv).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByTestId('session-first-overflow'));
    await userEvent.click(screen.getByTestId('use-legacy-dashboard'));
    expect(onLegacy).toHaveBeenCalledTimes(1);
  });
});
