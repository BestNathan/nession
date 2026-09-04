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

  it('opens anchored popover when more trigger is clicked', async () => {
    const onCommandsOpenChange = vi.fn();
    render(
      <CapsuleCommandsRow
        sendText={vi.fn()}
        commandsOpen={false}
        onCommandsOpenChange={onCommandsOpenChange}
      />,
    );
    await userEvent.click(screen.getByTestId('capsule-commands-more'));
    expect(onCommandsOpenChange).toHaveBeenCalled();
    expect(onCommandsOpenChange.mock.calls[0]?.[0]).toBe(true);
  });

  it('uses anchored popover for mobile more menu', () => {
    render(
      <CapsuleCommandsRow
        sendText={vi.fn()}
        commandsOpen
        onCommandsOpenChange={vi.fn()}
      />,
    );
    expect(document.querySelector('[data-slot="popover-content"]')).toBeInTheDocument();
    expect(document.querySelector('[data-slot="sheet-content"]')).not.toBeInTheDocument();
    expect(document.querySelector('[data-slot="sheet-overlay"]')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Commands' })).toBeInTheDocument();
  });

  it('keeps more trigger outside the scrollable quick-key row', () => {
    render(
      <CapsuleCommandsRow
        sendText={vi.fn()}
        commandsOpen={false}
        onCommandsOpenChange={vi.fn()}
      />,
    );
    const more = screen.getByTestId('capsule-commands-more');
    const tab = screen.getByTestId('capsule-quick-key-Tab');
    expect(more.parentElement?.className).toMatch(/shrink-0/);
    expect(tab.parentElement?.className).toMatch(/overflow-x-auto/);
    expect(more.parentElement).not.toBe(tab.parentElement);
  });
});
