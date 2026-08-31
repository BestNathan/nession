import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CapsuleHistoryPopover } from '@/session-first/capsule/CapsuleHistoryPopover';

vi.mock('@/hooks/useCommandHistory', () => ({
  useCommandHistory: () => ({
    filterHistory: () => [
      { id: '1', command: 'npm test', timestamp: Date.now() },
    ],
    history: [],
    addEntry: vi.fn(),
    removeEntry: vi.fn(),
    clearHistory: vi.fn(),
  }),
}));

describe('CapsuleHistoryPopover', () => {
  it('opens popover and selects a history row', async () => {
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <CapsuleHistoryPopover
        open
        onOpenChange={onOpenChange}
        onSelect={onSelect}
      />,
    );
    expect(screen.getByTestId('capsule-history-search')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('capsule-history-item'));
    expect(onSelect).toHaveBeenCalledWith('npm test');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
