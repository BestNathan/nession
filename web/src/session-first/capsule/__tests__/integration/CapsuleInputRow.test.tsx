import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CapsuleInputRow } from '@/session-first/capsule/CapsuleInputRow';
import type { ComposerLayout } from '@/session-first/capsule/types';

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
    history: [{ id: '1', command: 'ls -la', timestamp: Date.now() }],
    removeEntry: vi.fn(),
    clearHistory: vi.fn(),
    filterHistory: vi.fn().mockReturnValue([
      { id: '1', command: 'ls -la', timestamp: Date.now() },
    ]),
  }),
}));

function renderRow(onLayoutChange?: (layout: ComposerLayout) => void) {
  return render(
    <CapsuleInputRow
      sendText={vi.fn()}
      historyOpen={false}
      onHistoryOpenChange={vi.fn()}
      commandsOpen={false}
      onCommandsOpenChange={vi.fn()}
      onLayoutChange={onLayoutChange}
    />,
  );
}

describe('CapsuleInputRow', () => {
  it('shows History + Send on the right by default (no paste/copy/commands)', () => {
    renderRow();
    expect(screen.getByTestId('capsule-history-trigger')).toBeInTheDocument();
    expect(screen.getByTestId('capsule-send')).toBeInTheDocument();
    expect(screen.queryByTestId('capsule-paste')).not.toBeInTheDocument();
    expect(screen.queryByTestId('capsule-copy')).not.toBeInTheDocument();
    expect(screen.queryByTestId('capsule-commands-trigger')).not.toBeInTheDocument();
    // Actions live in the trailing slot, not a left tools cluster
    expect(screen.getByTestId('capsule-input-actions-slot')).toBeInTheDocument();
  });

  it('shows paste/copy when enabled (mobile)', () => {
    render(
      <CapsuleInputRow
        sendText={vi.fn()}
        historyOpen={false}
        onHistoryOpenChange={vi.fn()}
        commandsOpen={false}
        onCommandsOpenChange={vi.fn()}
        showPasteCopy
      />,
    );
    expect(screen.getByTestId('capsule-paste')).toBeInTheDocument();
    expect(screen.getByTestId('capsule-copy')).toBeInTheDocument();
  });

  it('opens history popover from the trigger', async () => {
    const onHistoryOpenChange = vi.fn();
    const { rerender } = render(
      <CapsuleInputRow
        sendText={vi.fn()}
        historyOpen={false}
        onHistoryOpenChange={onHistoryOpenChange}
        commandsOpen={false}
        onCommandsOpenChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByTestId('capsule-history-trigger'));
    expect(onHistoryOpenChange).toHaveBeenCalledWith(true);

    rerender(
      <CapsuleInputRow
        sendText={vi.fn()}
        historyOpen={true}
        onHistoryOpenChange={onHistoryOpenChange}
        commandsOpen={false}
        onCommandsOpenChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('capsule-history-search')).toBeInTheDocument();
    expect(screen.getByText('ls -la')).toBeInTheDocument();
  });

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

  it('uses flat layout for single-line input', () => {
    renderRow();
    const row = screen.getByTestId('capsule-input-row');
    expect(row).toHaveAttribute('data-layout', 'flat');
    expect(row.className).toMatch(/grid-cols-\[minmax/);
  });

  it('switches to stacked layout for multi-line without dropping focus', async () => {
    const onLayoutChange = vi.fn();
    render(
      <CapsuleInputRow
        sendText={vi.fn()}
        historyOpen={false}
        onHistoryOpenChange={vi.fn()}
        commandsOpen={false}
        onCommandsOpenChange={vi.fn()}
        onLayoutChange={onLayoutChange}
      />,
    );
    const input = screen.getByTestId('capsule-ghost-input');
    input.focus();
    await userEvent.type(input, 'line1{Shift>}{Enter}{/Shift}line2');

    await waitFor(() => {
      expect(screen.getByTestId('capsule-input-row')).toHaveAttribute(
        'data-layout',
        'stacked',
      );
    });
    expect(onLayoutChange).toHaveBeenCalledWith('stacked');
    expect(document.activeElement).toBe(input);
    expect(screen.getByTestId('capsule-input-field').className).toMatch(/col-span-3/);
    expect(screen.getByTestId('capsule-input-actions-slot').className).toMatch(
      /row-start-2/,
    );
  });

  it('returns to flat when content is single line again', async () => {
    renderRow();
    const input = screen.getByTestId('capsule-ghost-input');
    await userEvent.type(input, 'a{Shift>}{Enter}{/Shift}b');
    await waitFor(() => {
      expect(screen.getByTestId('capsule-input-row')).toHaveAttribute(
        'data-layout',
        'stacked',
      );
    });
    await userEvent.clear(input);
    await userEvent.type(input, 'one');
    await waitFor(() => {
      expect(screen.getByTestId('capsule-input-row')).toHaveAttribute(
        'data-layout',
        'flat',
      );
    });
    expect(document.activeElement).toBe(input);
  });

  it('returns to flat after send clears input', async () => {
    const sendText = vi.fn();
    const onHistoryOpenChange = vi.fn();
    render(
      <CapsuleInputRow
        sendText={sendText}
        historyOpen={true}
        onHistoryOpenChange={onHistoryOpenChange}
        commandsOpen={false}
        onCommandsOpenChange={vi.fn()}
      />,
    );
    const input = screen.getByTestId('capsule-ghost-input');
    await userEvent.type(input, 'a{Shift>}{Enter}{/Shift}b');
    await waitFor(() => {
      expect(screen.getByTestId('capsule-input-row')).toHaveAttribute(
        'data-layout',
        'stacked',
      );
    });
    await userEvent.click(screen.getByTestId('capsule-send'));
    expect(sendText).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByTestId('capsule-input-row')).toHaveAttribute(
        'data-layout',
        'flat',
      );
    });
    expect(onHistoryOpenChange).toHaveBeenCalledWith(false);
  });
});
