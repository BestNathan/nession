import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TerminalCapsule } from '@/features/terminal/capsule/TerminalCapsule';

describe('capsule capability presence', () => {
  it('renders no capability chrome when nothing earned presence', () => {
    render(<TerminalCapsule experience="web" sendText={vi.fn()} />);

    expect(screen.queryByTestId('capsule-capability')).not.toBeInTheDocument();
    // The capsule itself is still there — only the capability contribution is absent.
    expect(screen.getByTestId('terminal-capsule')).toBeInTheDocument();
  });

  it('renders the capability that earned presence, with its state', () => {
    render(
      <TerminalCapsule
        experience="web"
        sendText={vi.fn()}
        capability={{
          id: 'claude-code',
          label: 'Claude Code',
          state: 'active',
          onActivate: vi.fn(),
        }}
      />,
    );

    const chip = screen.getByTestId('capsule-capability');
    expect(chip).toHaveTextContent('Claude Code');
    expect(chip).toHaveAttribute('data-capability-state', 'active');
  });

  it('activates the capability when pressed', async () => {
    const onActivate = vi.fn();
    render(
      <TerminalCapsule
        experience="web"
        sendText={vi.fn()}
        capability={{
          id: 'claude-code',
          label: 'Claude Code',
          state: 'relevant',
          onActivate,
        }}
      />,
    );

    await userEvent.click(screen.getByTestId('capsule-capability'));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('keeps the capsule to a single capability contribution', () => {
    render(
      <TerminalCapsule
        experience="web"
        sendText={vi.fn()}
        capability={{
          id: 'claude-code',
          label: 'Claude Code',
          state: 'relevant',
          onActivate: vi.fn(),
        }}
      />,
    );

    expect(screen.getAllByTestId('capsule-capability')).toHaveLength(1);
  });
});
