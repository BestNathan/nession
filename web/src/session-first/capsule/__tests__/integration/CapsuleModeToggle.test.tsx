import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CapsuleModeToggle } from '@/session-first/capsule/CapsuleModeToggle';

describe('CapsuleModeToggle', () => {
  it('fires onModeChange when switching modes', async () => {
    const onModeChange = vi.fn();
    render(<CapsuleModeToggle mode="input" onModeChange={onModeChange} />);
    await userEvent.click(screen.getByTestId('capsule-mode-commands'));
    expect(onModeChange).toHaveBeenCalledWith('commands');
  });
});
