import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TerminalCapsule } from '@/product/terminal/capsule/TerminalCapsule';
import type { CapsuleCapabilityProjection } from '@/product/terminal/capsule/types';

vi.mock('@/product/terminal/hooks/useCommandHistory', () => ({
  useCommandHistory: () => ({
    addEntry: vi.fn(),
    history: [],
    removeEntry: vi.fn(),
    clearHistory: vi.fn(),
    filterHistory: vi.fn().mockReturnValue([]),
  }),
}));

/**
 * A projection the capsule is showing, built here rather than taken from a real
 * capability: what is under test is the capsule's reaction to the flag, and the
 * flag is the capability's own declaration. `useCapsuleCapability.test.tsx` is
 * what proves the real Terminal Keys binding carries it and Git's does not.
 */
function projection(
  overrides: Partial<CapsuleCapabilityProjection> = {},
): CapsuleCapabilityProjection {
  return {
    id: 'terminal-keys',
    title: 'Terminal Keys',
    depth: 'signal',
    body: () => <p data-testid="projection-body">keys</p>,
    onDismiss: vi.fn(),
    ...overrides,
  };
}

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

/**
 * #1034 criteria 7, 8 and 14 — the composer persists, and the accessory yields.
 *
 * One boolean the capability declared drives both halves, so the capsule never
 * learns a capability id. Each direction is asserted for a projection that
 * claims the keyboard *and* for one that does not: an implementation that
 * always blurred, or always dismissed, would satisfy the first case of each
 * pair and silently break `git commit` while Git's Signal is up.
 */
describe('capsule input focus', () => {
  it('dismisses the keyboard when a projection that claims it appears', () => {
    // Blurring the field is what dismisses a soft keyboard — there is no
    // declarative equivalent — and leaving the IME up would cover the accessory
    // it competes with.
    const { rerender } = render(<TerminalCapsule experience="app" sendText={vi.fn()} />);
    const field = screen.getByTestId('capsule-ghost-input');
    field.focus();
    expect(document.activeElement).toBe(field);

    rerender(
      <TerminalCapsule
        experience="app"
        sendText={vi.fn()}
        capabilityProjection={projection({ ownsInputFocus: true })}
      />,
    );

    expect(document.activeElement).not.toBe(field);
  });

  it('leaves the composer focused for a projection that is read while typing', () => {
    // Git's shape: a Signal is not a reason to take the keyboard away from a
    // `git commit` in progress.
    const { rerender } = render(<TerminalCapsule experience="app" sendText={vi.fn()} />);
    const field = screen.getByTestId('capsule-ghost-input');
    field.focus();

    rerender(
      <TerminalCapsule
        experience="app"
        sendText={vi.fn()}
        capabilityProjection={projection({ id: 'git', title: 'Git' })}
      />,
    );

    expect(document.activeElement).toBe(field);
  });

  it('returns to text entry when the composer is tapped while the keys are up', async () => {
    // Criterion 8 via 14: one secondary surface owns focus, and the way out of
    // Terminal Keys is the composer itself. The projection steps out; nothing
    // about the Session or the Terminal is part of what was dismissed.
    const onDismiss = vi.fn();
    render(
      <TerminalCapsule
        experience="app"
        sendText={vi.fn()}
        capabilityProjection={projection({ ownsInputFocus: true, onDismiss })}
      />,
    );

    const field = screen.getByTestId('capsule-ghost-input');
    await userEvent.click(field);

    expect(document.activeElement).toBe(field);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('leaves a projection up when the composer is tapped, if it never claimed the keyboard', async () => {
    const onDismiss = vi.fn();
    render(
      <TerminalCapsule
        experience="app"
        sendText={vi.fn()}
        capabilityProjection={projection({ id: 'git', title: 'Git', onDismiss })}
      />,
    );

    const field = screen.getByTestId('capsule-ghost-input');
    await userEvent.click(field);

    expect(document.activeElement).toBe(field);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
