import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CapsuleCommandsPopover } from '@/session-first/capsule/CapsuleCommandsPopover';
import {
  ARROW_KEYS,
  CHAIN_LONG_PRESS_MS,
  LEFT_KEYS,
} from '@/session-first/capsule/physKeys';

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

  it('renders the complete physical-key layout and command footer in the expanded panel', async () => {
    render(
      <CapsuleCommandsPopover
        open
        onOpenChange={vi.fn()}
        sendText={sendText}
        showPhysKeys
      />,
    );
    expect(screen.getByTestId('phys-key-row')).toBeInTheDocument();
    expect(screen.queryByTestId('phys-key-overflow')).not.toBeInTheDocument();

    for (const keyDef of [...LEFT_KEYS, ...ARROW_KEYS]) {
      expect(screen.getByTestId(`phys-key-${keyDef.label}`)).toBeInTheDocument();
    }

    expect(screen.getByRole('button', { name: /Ctrl\+C/ })).toBeInTheDocument();
    const addCommand = screen.getByTestId('capsule-add-command');
    expect(addCommand).toBeInTheDocument();
    expect(addCommand).not.toBeDisabled();
    await userEvent.click(addCommand);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
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

  it('sends an arrow physical key once and closes after execution', async () => {
    const onOpenChange = vi.fn();
    render(
      <CapsuleCommandsPopover
        open
        onOpenChange={onOpenChange}
        sendText={sendText}
        showPhysKeys
      />,
    );

    await userEvent.click(screen.getByTestId('phys-key-↑'));

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith('\x1b[A');
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closes after sending an Esc + right-arrow chain built through long-press', () => {
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

    const secondKey = screen.getByTestId('phys-key-→');
    fireEvent.pointerDown(secondKey);
    fireEvent.pointerUp(secondKey);

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(sendText).toHaveBeenCalledTimes(1);
    // The chain payload is Esc (\x1b) followed by right arrow (\x1b[C).
    expect(sendText).toHaveBeenCalledWith('\x1b\x1b[C');
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders the commands panel as an anchored popover', () => {
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
