import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TerminalCapsule } from '@/session-first/capsule/TerminalCapsule';

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

describe('TerminalCapsule', () => {
  it('never renders legacy sheet', () => {
    render(<TerminalCapsule variant="desktop" sendText={vi.fn()} />);
    expect(screen.queryByTestId('terminal-capsule-sheet')).not.toBeInTheDocument();
  });

  it('renders desktop input row with commands trigger', () => {
    render(<TerminalCapsule variant="desktop" sendText={vi.fn()} />);
    expect(screen.getByTestId('capsule-input-row')).toBeInTheDocument();
    expect(screen.getByTestId('capsule-commands-trigger')).toBeInTheDocument();
    expect(screen.queryByTestId('capsule-mode-toggle')).not.toBeInTheDocument();
  });

  it('renders mobile mode toggle and switches body', async () => {
    const onModeChange = vi.fn();
    const { rerender } = render(
      <TerminalCapsule
        variant="mobile"
        mode="input"
        onModeChange={onModeChange}
        sendText={vi.fn()}
      />,
    );
    expect(screen.getByTestId('capsule-mode-toggle')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('capsule-mode-commands'));
    expect(onModeChange).toHaveBeenCalledWith('commands');

    rerender(
      <TerminalCapsule
        variant="mobile"
        mode="commands"
        onModeChange={onModeChange}
        sendText={vi.fn()}
      />,
    );
    expect(screen.getByTestId('capsule-commands-row')).toBeInTheDocument();
  });

  it('marks disabled state', () => {
    render(<TerminalCapsule variant="desktop" sendText={vi.fn()} disabled />);
    expect(screen.getByTestId('terminal-capsule')).toHaveAttribute('data-disabled', 'true');
  });

  it('uses safe-area positioning classes', () => {
    render(<TerminalCapsule variant="desktop" sendText={vi.fn()} />);
    const root = screen.getByTestId('terminal-capsule');
    expect(root.className).toMatch(/bottom-\[max\(0\.75rem,env\(safe-area-inset-bottom\)\)\]/);
  });
});
