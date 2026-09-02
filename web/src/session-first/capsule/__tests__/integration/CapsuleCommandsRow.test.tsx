import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CapsuleCommandsRow } from '@/session-first/capsule/CapsuleCommandsRow';

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

describe('CapsuleCommandsRow', () => {
  it('sends quick key taps', async () => {
    const sendText = vi.fn();
    render(
      <CapsuleCommandsRow
        sendText={sendText}
        commandsOpen={false}
        onCommandsOpenChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByTestId('capsule-quick-key-Tab'));
    expect(sendText).toHaveBeenCalledWith('\t');
  });

  it('renders more commands trigger', () => {
    render(
      <CapsuleCommandsRow
        sendText={vi.fn()}
        commandsOpen={false}
        onCommandsOpenChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('capsule-commands-more')).toBeInTheDocument();
  });
});
