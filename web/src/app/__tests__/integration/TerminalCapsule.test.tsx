import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TerminalCapsule } from '@/product/terminal/capsule/TerminalCapsule';

vi.mock('@/capabilities/commands/hooks/useQuickCommands', () => ({
  useQuickCommands: () => ({
    userCommands: [],
    addCommand: vi.fn().mockResolvedValue(undefined),
    deleteCommand: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/product/terminal/hooks/useCommandHistory', () => ({
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

  it('renders the App resting capsule as one row: `+`, field, one action', () => {
    // The App capsule at rest is a minimal intent composer — terminal-capsule.md
    // §Anatomy's `[+] [ input ... ] [send]` — so the row is a single band at
    // control.md height rather than a field stacked on a toolbar row.
    render(
      <TerminalCapsule
        experience="app"
        sendText={vi.fn()}
        capabilityDisclosure={{
          entries: [{ id: 'claude-code', title: 'Claude Code', state: 'active' }],
          onSelect: vi.fn(),
        }}
      />,
    );

    expect(screen.getByTestId('capsule-input-row')).toHaveAttribute('data-layout', 'flat');
    expect(screen.queryByTestId('capsule-input-toolbar-row')).not.toBeInTheDocument();
    expect(screen.getByTestId('capsule-input-field')).toHaveAttribute(
      'data-input-width',
      'column',
    );

    const leading = within(screen.getByTestId('capsule-input-leading-slot'));
    expect(leading.getByTestId('capsule-capability-more')).toBeInTheDocument();

    // Exactly one action — the primary send. App gets no permanent history,
    // paste, copy or mode control beside it.
    const actions = within(screen.getByTestId('capsule-input-actions'));
    expect(actions.getAllByRole('button')).toHaveLength(1);
    for (const testId of [
      'capsule-history-trigger',
      'capsule-paste',
      'capsule-copy',
      'capsule-mode-toggle',
    ]) {
      expect(screen.queryByTestId(testId)).not.toBeInTheDocument();
    }
  });

  it('moves to the field-first layout once the input wraps', async () => {
    render(<TerminalCapsule experience="app" sendText={vi.fn()} />);
    const input = screen.getByTestId('capsule-ghost-input');
    await userEvent.type(input, 'line1{Shift>}{Enter}{/Shift}line2');

    await waitFor(() => {
      expect(screen.getByTestId('capsule-input-row')).toHaveAttribute('data-layout', 'stacked');
    });
    expect(screen.getByTestId('capsule-input-field')).toHaveAttribute('data-input-width', 'full');
    expect(screen.getByTestId('capsule-input-toolbar-row')).toBeInTheDocument();
  });

  it('marks disabled state', () => {
    render(<TerminalCapsule experience="web" sendText={vi.fn()} disabled />);
    expect(screen.getByTestId('terminal-capsule')).toHaveAttribute('data-disabled', 'true');
  });

  it('uses token capsule surface and pill radius on web flat shell', () => {
    render(<TerminalCapsule experience="web" sendText={vi.fn()} />);
    const shell = screen.getByTestId('capsule-shell');
    expect(shell.className).toMatch(/terminal-capsule-surface/);
    expect(shell.className).toMatch(/terminal-capsule-shell-pill-radius/);
    expect(screen.getByTestId('terminal-capsule')).toHaveAttribute('data-shell-shape', 'pill');
  });

  it('stretches a full-width dock between shell margins on web', () => {
    render(<TerminalCapsule experience="web" sendText={vi.fn()} />);
    const root = screen.getByTestId('terminal-capsule');
    expect(root).toHaveAttribute('data-experience', 'web');
    expect(root.className).toMatch(/terminal-capsule-shell-margin-x/);
    expect(root.className).toMatch(/items-stretch/);
    const shell = screen.getByTestId('capsule-shell');
    expect(shell.className).toMatch(/w-full/);
    expect(shell.className).not.toMatch(/terminal-capsule-shell-max-width/);
  });

  it('uses inset positioning on app', () => {
    render(<TerminalCapsule experience="app" sendText={vi.fn()} />);
    const root = screen.getByTestId('terminal-capsule');
    expect(root).toHaveAttribute('data-experience', 'app');
    expect(root.className).toMatch(/terminal-capsule-shell-inset/);
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

  it('defaults to the web experience when none is given', () => {
    render(<TerminalCapsule sendText={vi.fn()} />);
    expect(screen.getByTestId('terminal-capsule')).toHaveAttribute('data-experience', 'web');
  });
});
