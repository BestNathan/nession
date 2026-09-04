import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CapsuleCommandsPopover } from '@/session-first/capsule/CapsuleCommandsPopover';
import { CHAIN_LONG_PRESS_MS } from '@/session-first/capsule/physKeys';

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

describe('CapsuleCommandsPopover', () => {
  const sendText = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hides phys keys when showPhysKeys is false', () => {
    render(
      <CapsuleCommandsPopover
        open
        onOpenChange={vi.fn()}
        sendText={sendText}
        showPhysKeys={false}
      />,
    );
    expect(screen.queryByTestId('phys-key-row')).not.toBeInTheDocument();
  });

  it('shows compact primary phys keys and keeps arrows in overflow', async () => {
    render(
      <CapsuleCommandsPopover
        open
        onOpenChange={vi.fn()}
        sendText={sendText}
        showPhysKeys
      />,
    );
    expect(screen.getByTestId('phys-key-row')).toBeInTheDocument();
    const scroll = screen.getByTestId('phys-key-scroll');
    expect(scroll).toHaveClass('overflow-x-auto');
    expect(scroll).toHaveClass('flex-1');
    const overflow = screen.getByTestId('phys-key-overflow');
    expect(overflow).toBeInTheDocument();
    expect(overflow.parentElement).toHaveClass('shrink-0');
    expect(scroll.contains(overflow)).toBe(false);
    expect(screen.getByTestId('phys-key-Ctrl+C')).toBeInTheDocument();

    for (const label of ['↑', '←', '↓', '→']) {
      expect(screen.queryByTestId(`phys-key-${label}`)).not.toBeInTheDocument();
    }

    await userEvent.click(screen.getByTestId('phys-key-overflow'));
    for (const label of ['↑', '←', '↓', '→']) {
      expect(await screen.findByRole('menuitem', { name: label })).toBeInTheDocument();
    }
  });

  it('runs preset command on click', async () => {
    render(
      <CapsuleCommandsPopover
        open
        onOpenChange={vi.fn()}
        sendText={sendText}
        showPhysKeys={false}
      />,
    );
    await userEvent.click(screen.getByText('Ctrl+C'));
    expect(sendText).toHaveBeenCalledWith('\x03');
  });

  it('opens add command dialog', async () => {
    render(
      <CapsuleCommandsPopover
        open
        onOpenChange={vi.fn()}
        sendText={sendText}
        showPhysKeys={false}
      />,
    );
    await userEvent.click(screen.getByTestId('capsule-add-command'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes after running a built-in command', async () => {
    const onOpenChange = vi.fn();
    render(
      <CapsuleCommandsPopover
        open
        onOpenChange={onOpenChange}
        sendText={sendText}
        showPhysKeys={false}
      />,
    );
    await userEvent.click(screen.getByText('Ctrl+C'));
    expect(sendText).toHaveBeenCalledWith('\x03');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('sends a visible physical key once and closes after execution', async () => {
    const onOpenChange = vi.fn();
    render(
      <CapsuleCommandsPopover
        open
        onOpenChange={onOpenChange}
        sendText={sendText}
        showPhysKeys
      />,
    );

    await userEvent.click(screen.getByTestId('phys-key-Esc'));

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith('\x1b');
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('sends an overflow physical key once and closes after execution', async () => {
    const onOpenChange = vi.fn();
    render(
      <CapsuleCommandsPopover
        open
        onOpenChange={onOpenChange}
        sendText={sendText}
        showPhysKeys
      />,
    );

    await userEvent.click(screen.getByTestId('phys-key-overflow'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'PgDn' }));

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith('\x1b[6~');
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closes after sending a chain built through long-press start and add', () => {
    vi.useFakeTimers();
    const onOpenChange = vi.fn();
    render(
      <CapsuleCommandsPopover
        open
        onOpenChange={onOpenChange}
        sendText={sendText}
        showPhysKeys
      />,
    );

    const firstKey = screen.getByTestId('phys-key-Esc');
    fireEvent.pointerDown(firstKey);
    act(() => {
      vi.advanceTimersByTime(CHAIN_LONG_PRESS_MS);
    });
    fireEvent.pointerUp(firstKey);
    expect(screen.getByTestId('capsule-chain-bar')).toBeInTheDocument();

    const secondKey = screen.getByTestId('phys-key-Tab');
    fireEvent.pointerDown(secondKey);
    fireEvent.pointerUp(secondKey);

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith('\x1b\t');
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders the mobile anchored popover', () => {
    render(
      <CapsuleCommandsPopover
        open
        onOpenChange={vi.fn()}
        sendText={sendText}
        showPhysKeys
        trigger={<button type="button" data-testid="capsule-commands-more">More</button>}
      />,
    );
    expect(document.querySelector('[data-slot="popover-content"]')).toBeInTheDocument();
    expect(document.querySelector('[data-slot="sheet-content"]')).not.toBeInTheDocument();
    expect(document.querySelector('[data-slot="sheet-overlay"]')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Quick commands' })).toBeInTheDocument();
  });
});
