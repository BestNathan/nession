import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Bot, Folder } from 'lucide-react';
import { TerminalCapsule } from '@/product/terminal/capsule/TerminalCapsule';

describe('capsule capability presence', () => {
  it('renders no capability chrome at rest', () => {
    render(<TerminalCapsule experience="web" sendText={vi.fn()} />);

    expect(screen.queryByTestId('capsule-capability')).not.toBeInTheDocument();
    // The capsule itself is still there — only the capability contribution is absent.
    expect(screen.getByTestId('terminal-capsule')).toBeInTheDocument();
  });

  it('never puts capability identity on the resting capsule, whatever the states are', () => {
    // SC4. The revision (#748 / terminal-capsule.md 2026-09-16): capability state
    // lives in `+`. The observable consequence is that an active capability
    // changes nothing about the resting surface.
    const { container: quiet } = render(<TerminalCapsule experience="web" sendText={vi.fn()} />);

    const { container: withActive } = render(
      <TerminalCapsule
        experience="web"
        sendText={vi.fn()}
        capabilityDisclosure={{
          entries: [{ id: 'claude-code', title: 'Claude Code', state: 'active', icon: Bot }],
          onSelect: vi.fn(),
        }}
      />,
    );

    // The `+` control is an icon button with an accessible name and no text, so
    // the resting capsule's visible text is identical in both cases.
    expect(withActive.textContent).toBe(quiet.textContent);
    expect(screen.queryAllByTestId('capsule-capability')).toHaveLength(0);
  });
});

describe('capsule capability disclosure', () => {
  it('renders no discovery entry when nothing earned disclosure', () => {
    render(<TerminalCapsule experience="web" sendText={vi.fn()} />);

    expect(screen.queryByTestId('capsule-capability-more')).not.toBeInTheDocument();
  });

  it('marks a perceived capability in the list and activates the one chosen', async () => {
    const onSelect = vi.fn();
    render(
      <TerminalCapsule
        experience="web"
        sendText={vi.fn()}
        capabilityDisclosure={{
          entries: [
            { id: 'claude-code', title: 'Claude Code', state: 'active', icon: Bot },
            { id: 'env', title: 'Environment Files', state: 'available', icon: Folder },
          ],
          onSelect,
        }}
      />,
    );

    await userEvent.click(screen.getByTestId('capsule-capability-more'));

    // The state travels with the entry so the list can mark it — this is the
    // one place a capability's state is allowed to show.
    const active = await screen.findByTestId('capsule-capability-picker-claude-code');
    expect(active).toHaveAttribute('data-capability-state', 'active');
    const available = screen.getByTestId('capsule-capability-picker-env');
    expect(available).toHaveAttribute('data-capability-state', 'available');

    // The list is no longer a portalled menu, so there is no open transition to
    // wait out before the row accepts a click — that wait existed because the
    // popup primitive held its content inert, and this surface never does.
    await userEvent.click(available);
    expect(onSelect).toHaveBeenCalledWith('env');
  });
});
