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
    expect(row.className).toMatch(/items-center/);
    expect(row.className).toMatch(/grid-cols-\[minmax/);
  });

  it('stays flat when empty even if scrollHeight looks multi-line (mobile)', async () => {
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return 52;
      },
    });

    try {
      const onLayoutChange = vi.fn();
      renderRow(onLayoutChange);
      await waitFor(() => {
        expect(screen.getByTestId('capsule-input-row')).toHaveAttribute(
          'data-layout',
          'flat',
        );
      });
      expect(onLayoutChange).not.toHaveBeenCalledWith('stacked');
    } finally {
      Reflect.deleteProperty(HTMLTextAreaElement.prototype, 'scrollHeight');
    }
  });

  it('uses shared body type on the field', () => {
    renderRow();
    const input = screen.getByTestId('capsule-ghost-input');
    expect(input.className).toMatch(/sf-text-body/);
    expect(input.className).toMatch(/sf-capsule-line/);
  });

  it('keeps History and Send at the same control size', () => {
    renderRow();
    expect(screen.getByTestId('capsule-history-trigger').className).toMatch(/size-8/);
    expect(screen.getByTestId('capsule-send').className).toMatch(/size-8/);
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
    // Field stays in the fr column (not col-span across actions) so wrap width is stable
    expect(screen.getByTestId('capsule-input-field').className).not.toMatch(/col-span-3/);
    expect(screen.getByTestId('capsule-input-actions-slot').className).toMatch(
      /row-start-2/,
    );
  });

  it('does not oscillate when soft-wrap height depends on flat vs stacked width', async () => {
    // Reproduce React #185: stacked used to col-span the field under the
    // actions column (wider) so soft-wrap unwraps → flat → wrap → loop.
    const onLayoutChange = vi.fn();
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLTextAreaElement) {
        const field = this.closest('[data-testid="capsule-input-field"]');
        const spansFull = Boolean(field?.className.includes('col-span-3'));
        if (this.value.length >= 24) {
          // Narrow (no span) wraps to 2 lines; full-span unwraps to 1
          return spansFull ? 32 : 52;
        }
        return 32;
      },
    });

    try {
      renderRow(onLayoutChange);
      const input = screen.getByTestId('capsule-ghost-input');
      await userEvent.type(input, 'x'.repeat(28));

      await waitFor(() => {
        expect(screen.getByTestId('capsule-input-row')).toHaveAttribute(
          'data-layout',
          'stacked',
        );
      });
      // Settled — not thrashing flat/stacked on every layout effect
      expect(onLayoutChange.mock.calls.length).toBeLessThan(5);
      expect(onLayoutChange).toHaveBeenCalledWith('stacked');
      expect(
        onLayoutChange.mock.calls.filter((c) => c[0] === 'flat').length,
      ).toBe(0);
    } finally {
      Reflect.deleteProperty(HTMLTextAreaElement.prototype, 'scrollHeight');
    }
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
        historyOpen={false}
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
