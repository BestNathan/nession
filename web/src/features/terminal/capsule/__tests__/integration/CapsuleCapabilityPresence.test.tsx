import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

describe('capsule capability disclosure', () => {
  it('renders no discovery entry when nothing earned disclosure', () => {
    render(<TerminalCapsule experience="web" sendText={vi.fn()} />);

    expect(screen.queryByTestId('capsule-capability-more')).not.toBeInTheDocument();
  });

  it('offers capabilities that earned no chip, and activates the one chosen', async () => {
    const onSelect = vi.fn();
    render(
      <TerminalCapsule
        experience="web"
        sendText={vi.fn()}
        capabilityDisclosure={{
          entries: [
            { id: 'files', title: 'Files', state: 'available' },
            { id: 'env', title: 'Environment Files', state: 'available' },
          ],
          onSelect,
        }}
      />,
    );

    await userEvent.click(screen.getByTestId('capsule-capability-more'));

    const entry = await screen.findByTestId('capsule-capability-picker-env');
    expect(entry).toHaveAttribute('data-capability-state', 'available');
    // Base UI holds the popup inert until its open transition settles.
    await waitFor(() => {
      expect(entry).not.toHaveStyle({ pointerEvents: 'none' });
    });

    await userEvent.click(entry);
    expect(onSelect).toHaveBeenCalledWith('env');
  });

  it('keeps the chip and the discovery entry independent', () => {
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
        capabilityDisclosure={{
          entries: [{ id: 'files', title: 'Files', state: 'available' }],
          onSelect: vi.fn(),
        }}
      />,
    );

    expect(screen.getByTestId('capsule-capability')).toHaveAttribute(
      'data-capability-state',
      'active',
    );
    expect(screen.getByTestId('capsule-capability-more')).toBeInTheDocument();
  });
});
