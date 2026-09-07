import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CapsuleCommandsPanel } from '@/session-first/capsule/CapsuleCommandsPanel';

vi.mock('@/hooks/useQuickCommands', () => ({
  useQuickCommands: () => ({
    userCommands: [],
    addCommand: vi.fn().mockResolvedValue(undefined),
    deleteCommand: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/hooks/useCommandHistory', () => ({
  useCommandHistory: () => ({
    addEntry: vi.fn(),
    history: [],
    removeEntry: vi.fn(),
    clearHistory: vi.fn(),
    filterHistory: vi.fn().mockReturnValue([]),
  }),
}));

describe('CapsuleCommandsPanel', () => {
  it('renders inline panel with close button and phys keys', async () => {
    const onClose = vi.fn();
    render(
      <CapsuleCommandsPanel
        sendText={vi.fn()}
        disabled={false}
        showPhysKeys
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
