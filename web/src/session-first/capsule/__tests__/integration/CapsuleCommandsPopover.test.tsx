import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CapsuleCommandsPopover } from '@/session-first/capsule/CapsuleCommandsPopover';

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

  it('shows phys keys when showPhysKeys is true', () => {
    render(
      <CapsuleCommandsPopover
        open
        onOpenChange={vi.fn()}
        sendText={sendText}
        showPhysKeys
      />,
    );
    expect(screen.getByTestId('phys-key-row')).toBeInTheDocument();
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

  it('renders bottom sheet when presentation is sheet', () => {
    render(
      <CapsuleCommandsPopover
        open
        onOpenChange={vi.fn()}
        sendText={sendText}
        showPhysKeys
        presentation="sheet"
        trigger={<button type="button" data-testid="capsule-commands-more">More</button>}
      />,
    );
    const sheet = document.querySelector('[data-slot="sheet-content"][data-side="bottom"]');
    expect(sheet).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Commands' })).toBeInTheDocument();
  });

  it('keeps the mobile commands sheet backdrop clear', () => {
    render(
      <CapsuleCommandsPopover
        open
        onOpenChange={vi.fn()}
        sendText={sendText}
        showPhysKeys
        presentation="sheet"
        trigger={<button type="button" data-testid="capsule-commands-more">More</button>}
      />,
    );
    const overlay = document.querySelector('[data-slot="sheet-overlay"]');
    expect(overlay).toBeInTheDocument();
    expect(overlay?.className).not.toContain('backdrop-blur-xs');
  });
});
