import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CapsuleCommandsPanel } from '@/features/terminal/capsule/CapsuleCommandsPanel';

vi.mock('@/features/commands/hooks/useQuickCommands', () => ({
  useQuickCommands: () => ({
    userCommands: [],
    addCommand: vi.fn().mockResolvedValue(undefined),
    deleteCommand: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/features/terminal/hooks/useCommandHistory', () => ({
  useCommandHistory: () => ({
    addEntry: vi.fn(),
    history: [],
    removeEntry: vi.fn(),
    clearHistory: vi.fn(),
    filterHistory: vi.fn().mockReturnValue([]),
  }),
}));

describe('CapsuleCommandsPanel', () => {
  it('renders overlay panel with close button, phys keys, and commands regions', async () => {
    const onClose = vi.fn();
    render(
      <CapsuleCommandsPanel
        sendText={vi.fn()}
        disabled={false}
        onClose={onClose}
      />,
    );
    expect(screen.getByTestId('capsule-commands-panel')).toBeInTheDocument();
    expect(screen.getByTestId('phys-key-row')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Close commands' }));
    expect(onClose).toHaveBeenCalled();
  });
});
