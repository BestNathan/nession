import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CapsuleInputRow } from '@/session-first/capsule/CapsuleInputRow';

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

describe('CapsuleInputRow', () => {
  it('disables send when empty and sends trimmed input with carriage return', async () => {
    const sendText = vi.fn();
    render(
      <CapsuleInputRow
        sendText={sendText}
        historyOpen={false}
        onHistoryOpenChange={vi.fn()}
        commandsOpen={false}
        onCommandsOpenChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('capsule-send')).toBeDisabled();
    await userEvent.type(screen.getByTestId('capsule-ghost-input'), 'hello');
    await userEvent.click(screen.getByTestId('capsule-send'));
    expect(sendText).toHaveBeenCalledWith('hello\r');
  });

  it('stays compact (row) for single-line input', () => {
    render(
      <CapsuleInputRow
        sendText={vi.fn()}
        historyOpen={false}
        onHistoryOpenChange={vi.fn()}
        commandsOpen={false}
        onCommandsOpenChange={vi.fn()}
      />,
    );
    const row = screen.getByTestId('capsule-input-row');
    expect(row).toHaveAttribute('data-expanded', 'false');
    expect(row.className).toMatch(/flex-row/);
    expect(screen.queryByTestId('capsule-input-toolbar')).not.toBeInTheDocument();
  });

  it('expands to column toolbar when content becomes multi-line', async () => {
    const onHeightChange = vi.fn();
    render(
      <CapsuleInputRow
        sendText={vi.fn()}
        historyOpen={false}
        onHistoryOpenChange={vi.fn()}
        commandsOpen={false}
        onCommandsOpenChange={vi.fn()}
        onHeightChange={onHeightChange}
      />,
    );
    await userEvent.type(
      screen.getByTestId('capsule-ghost-input'),
      'line1{Shift>}{Enter}{/Shift}line2',
    );
    await waitFor(() => {
      expect(screen.getByTestId('capsule-input-row')).toHaveAttribute('data-expanded', 'true');
    });
    expect(onHeightChange).toHaveBeenCalledWith('multi');
    expect(screen.getByTestId('capsule-input-toolbar')).toBeInTheDocument();
  });
});
