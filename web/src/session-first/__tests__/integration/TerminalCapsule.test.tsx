import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TerminalCapsule } from '@/session-first/TerminalCapsule';

describe('TerminalCapsule', () => {
  it('renders collapsed pill and requests expand', async () => {
    const onExpandedChange = vi.fn();
    render(
      <TerminalCapsule
        mode="input"
        onModeChange={vi.fn()}
        expanded={false}
        onExpandedChange={onExpandedChange}
        inputPanel={<div data-testid="input-panel">input</div>}
        commandsPanel={<div data-testid="commands-panel">cmds</div>}
      />,
    );
    expect(screen.getByTestId('terminal-capsule')).toBeInTheDocument();
    expect(screen.queryByTestId('terminal-capsule-sheet')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('terminal-capsule-expand'));
    expect(onExpandedChange).toHaveBeenCalledWith(true);
  });

  it('shows sheet content when expanded for active mode', () => {
    render(
      <TerminalCapsule
        mode="commands"
        onModeChange={vi.fn()}
        expanded
        onExpandedChange={vi.fn()}
        inputPanel={<div data-testid="input-panel" />}
        commandsPanel={<div data-testid="commands-panel" />}
      />,
    );
    expect(screen.getByTestId('terminal-capsule-sheet')).toBeInTheDocument();
    expect(screen.getByTestId('commands-panel')).toBeInTheDocument();
  });

  it('switches mode via mode controls', async () => {
    const onModeChange = vi.fn();
    render(
      <TerminalCapsule
        mode="input"
        onModeChange={onModeChange}
        expanded={false}
        onExpandedChange={vi.fn()}
        inputPanel={<div />}
        commandsPanel={<div />}
      />,
    );
    await userEvent.click(screen.getByTestId('terminal-capsule-mode-commands'));
    expect(onModeChange).toHaveBeenCalledWith('commands');
  });

  it('marks disabled state', () => {
    render(
      <TerminalCapsule
        mode="input"
        onModeChange={vi.fn()}
        expanded={false}
        onExpandedChange={vi.fn()}
        disabled
        inputPanel={<div />}
        commandsPanel={<div />}
      />,
    );
    expect(screen.getByTestId('terminal-capsule')).toHaveAttribute('data-disabled', 'true');
  });
});
