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

function renderRow(onHeightChange?: (h: 'single' | 'multi') => void) {
  return render(
    <CapsuleInputRow
      sendText={vi.fn()}
      historyOpen={false}
      onHistoryOpenChange={vi.fn()}
      commandsOpen={false}
      onCommandsOpenChange={vi.fn()}
      onHeightChange={onHeightChange}
    />,
  );
}

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

  it('stays compact for single-line input', () => {
    renderRow();
    const row = screen.getByTestId('capsule-input-row');
    expect(row).toHaveAttribute('data-expanded', 'false');
    expect(screen.getByTestId('capsule-input-left').className).toMatch(/row-start-1/);
    expect(screen.getByTestId('capsule-input-left').className).not.toMatch(/row-start-2/);
  });

  it('expands toolbar row when content becomes multi-line without remounting input', async () => {
    const onHeightChange = vi.fn();
    renderRow(onHeightChange);
    const input = screen.getByTestId('capsule-ghost-input');
    input.focus();
    expect(document.activeElement).toBe(input);

    await userEvent.type(input, 'line1{Shift>}{Enter}{/Shift}line2');

    await waitFor(() => {
      expect(screen.getByTestId('capsule-input-row')).toHaveAttribute('data-expanded', 'true');
    });
    expect(onHeightChange).toHaveBeenCalledWith('multi');
    expect(screen.getByTestId('capsule-input-left').className).toMatch(/row-start-2/);
    expect(screen.getByTestId('capsule-input-right').className).toMatch(/row-start-2/);
    // Same textarea node must keep focus across expand
    expect(document.activeElement).toBe(input);
  });

  it('keeps focus when collapsing back to single line', async () => {
    renderRow();
    const input = screen.getByTestId('capsule-ghost-input');
    input.focus();
    await userEvent.type(input, 'a{Shift>}{Enter}{/Shift}b');
    await waitFor(() => {
      expect(screen.getByTestId('capsule-input-row')).toHaveAttribute('data-expanded', 'true');
    });
    expect(document.activeElement).toBe(input);

    await userEvent.clear(input);
    await userEvent.type(input, 'one');
    await waitFor(() => {
      expect(screen.getByTestId('capsule-input-row')).toHaveAttribute('data-expanded', 'false');
    });
    expect(document.activeElement).toBe(input);
  });
});
