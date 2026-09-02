import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
    render(<TerminalCapsule experience="web" sendText={vi.fn()} />);
    expect(screen.queryByTestId('terminal-capsule-sheet')).not.toBeInTheDocument();
  });

  it('renders web input row with History + Send only', () => {
    render(<TerminalCapsule experience="web" sendText={vi.fn()} />);
    expect(screen.getByTestId('capsule-input-row')).toBeInTheDocument();
    expect(screen.getByTestId('capsule-history-trigger')).toBeInTheDocument();
    expect(screen.getByTestId('capsule-send')).toBeInTheDocument();
    expect(screen.queryByTestId('capsule-commands-trigger')).not.toBeInTheDocument();
    expect(screen.queryByTestId('capsule-paste')).not.toBeInTheDocument();
    expect(screen.queryByTestId('capsule-mode-toggle')).not.toBeInTheDocument();
  });

  it('shows paste/copy on app input mode', () => {
    render(
      <TerminalCapsule
        experience="app"
        mode="input"
        onModeChange={vi.fn()}
        sendText={vi.fn()}
      />,
    );
    expect(screen.getByTestId('capsule-paste')).toBeInTheDocument();
    expect(screen.getByTestId('capsule-copy')).toBeInTheDocument();
  });

  it('renders app mode toggle and switches body', async () => {
    const onModeChange = vi.fn();
    const { rerender } = render(
      <TerminalCapsule
        experience="app"
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
        experience="app"
        mode="commands"
        onModeChange={onModeChange}
        sendText={vi.fn()}
      />,
    );
    expect(screen.getByTestId('capsule-commands-row')).toBeInTheDocument();
  });

  it('marks disabled state', () => {
    render(<TerminalCapsule experience="web" sendText={vi.fn()} disabled />);
    expect(screen.getByTestId('terminal-capsule')).toHaveAttribute('data-disabled', 'true');
  });

  it('uses token capsule surface and pill radius on web flat shell', () => {
    render(<TerminalCapsule experience="web" sendText={vi.fn()} />);
    const shell = screen.getByTestId('capsule-shell');
    expect(shell.className).toMatch(/terminal-capsule-surface/);
    expect(shell.className).toMatch(/composer-shell-pill-radius/);
    expect(screen.getByTestId('terminal-capsule')).toHaveAttribute('data-shell-shape', 'pill');
  });

  it('stretches a full-width dock between shell margins on web', () => {
    render(<TerminalCapsule experience="web" sendText={vi.fn()} />);
    const root = screen.getByTestId('terminal-capsule');
    expect(root).toHaveAttribute('data-experience', 'web');
    expect(root.className).toMatch(/composer-shell-margin-x/);
    expect(root.className).toMatch(/items-stretch/);
    const shell = screen.getByTestId('capsule-shell');
    expect(shell.className).toMatch(/w-full/);
    expect(shell.className).not.toMatch(/composer-shell-max-width/);
  });

  it('uses inset positioning on app', () => {
    render(
      <TerminalCapsule experience="app" mode="input" onModeChange={vi.fn()} sendText={vi.fn()} />,
    );
    const root = screen.getByTestId('terminal-capsule');
    expect(root).toHaveAttribute('data-experience', 'app');
    expect(root.className).toMatch(/composer-shell-inset/);
  });

  it('does not draw a focus ring class on the ghost input', () => {
    render(<TerminalCapsule experience="web" sendText={vi.fn()} />);
    const input = screen.getByTestId('capsule-ghost-input');
    expect(input.className).toMatch(/focus-visible:outline-none/);
    expect(input.className).toMatch(/border-0/);
  });

  it('exposes flat layout by default and stacked on multiline input', async () => {
    render(<TerminalCapsule experience="web" sendText={vi.fn()} />);
    const root = screen.getByTestId('terminal-capsule');
    expect(root).toHaveAttribute('data-layout', 'flat');
    expect(root).toHaveAttribute('data-dock-height', 'single');

    const input = screen.getByTestId('capsule-ghost-input');
    await userEvent.type(input, 'line1{Shift>}{Enter}{/Shift}line2');

    await waitFor(() => {
      expect(root).toHaveAttribute('data-layout', 'stacked');
    });
    expect(root).toHaveAttribute('data-dock-height', 'multi');
    expect(root).toHaveAttribute('data-shell-shape', 'capsule');
    expect(screen.getByTestId('capsule-shell').className).toMatch(/radius-capsule/);
  });

  it('still accepts legacy variant prop', () => {
    render(<TerminalCapsule variant="desktop" sendText={vi.fn()} />);
    expect(screen.getByTestId('terminal-capsule')).toHaveAttribute('data-experience', 'web');
  });
});
