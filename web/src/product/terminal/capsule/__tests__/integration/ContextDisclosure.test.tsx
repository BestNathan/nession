import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TerminalCapsule } from '@/product/terminal/capsule/TerminalCapsule';
import type { CapsuleCapabilityDisclosure } from '@/product/terminal/capsule/types';
import type { ResolvedWorkContext } from '@/product/terminal/capsule/workAwareness';

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
 * The Context Disclosure (#1347 SC-18/SC-19/SC-20/SC-33/SC-35/SC-36), exercised
 * through the real capsule — the `+` is the only way a user reaches it, so a
 * test that rendered the surface directly would not prove the wiring.
 */

function disclosure(overrides: Partial<CapsuleCapabilityDisclosure> = {}): CapsuleCapabilityDisclosure {
  return {
    entries: [
      { id: 'claude-code', title: 'Claude Code', state: 'active' },
      { id: 'git', title: 'Git', state: 'available' },
    ],
    onSelect: vi.fn(),
    onSelectAtPeek: vi.fn(),
    ...overrides,
  };
}

function workContext(overrides: Partial<ResolvedWorkContext> = {}): ResolvedWorkContext {
  return {
    status: 'working',
    summaries: [
      { capabilityId: 'claude-code', status: 'working', summary: 'Working in this Session' },
    ],
    ...overrides,
  };
}

describe('Context Disclosure', () => {
  it('lists the sensed capability first, by display identity, and opens it at Peek', async () => {
    const caps = disclosure();
    render(
      <TerminalCapsule experience="web" sendText={vi.fn()} capabilityDisclosure={caps} workContext={workContext()} />,
    );

    await userEvent.click(screen.getByTestId('capsule-capability-more'));

    const item = await screen.findByTestId('capsule-context-item-claude-code');
    // Display identity and reason — the raw id is not product copy (SC-19).
    expect(item).toHaveTextContent('Claude Code');
    expect(item).toHaveTextContent('Working in this Session');
    expect(item).not.toHaveTextContent('claude-code');

    await userEvent.click(item);
    // Directly at Peek, not Signal (SC-20).
    expect(caps.onSelectAtPeek).toHaveBeenCalledWith('claude-code');
    expect(caps.onSelect).not.toHaveBeenCalled();
  });

  it('keeps the ordinary list behind `All capabilities` while working (SC-35)', async () => {
    const caps = disclosure();
    render(
      <TerminalCapsule experience="web" sendText={vi.fn()} capabilityDisclosure={caps} workContext={workContext()} />,
    );

    await userEvent.click(screen.getByTestId('capsule-capability-more'));
    expect(await screen.findByTestId('capsule-context-item-claude-code')).toBeInTheDocument();
    // The ordinary entries are not in the first layer any more…
    expect(screen.queryByTestId('capsule-capability-picker-git')).not.toBeInTheDocument();
    // …they are one explicit step away, in the same surface.
    expect(screen.getByTestId('capsule-context-all')).toBeInTheDocument();
  });

  it('is the ordinary capability list when nothing is sensed', async () => {
    const caps = disclosure();
    render(<TerminalCapsule experience="web" sendText={vi.fn()} capabilityDisclosure={caps} />);

    await userEvent.click(screen.getByTestId('capsule-capability-more'));
    const git = await screen.findByTestId('capsule-capability-picker-git');
    expect(screen.queryByTestId('capsule-context-all')).not.toBeInTheDocument();
    await userEvent.click(git);
    expect(caps.onSelect).toHaveBeenCalledWith('git');
  });

  it('dismisses itself when the sensed work ends while it is open (SC-36)', async () => {
    const caps = disclosure();
    const { rerender } = render(
      <TerminalCapsule experience="web" sendText={vi.fn()} capabilityDisclosure={caps} workContext={workContext()} />,
    );

    await userEvent.click(screen.getByTestId('capsule-capability-more'));
    expect(await screen.findByTestId('capsule-context-item-claude-code')).toBeInTheDocument();

    rerender(
      <TerminalCapsule
        experience="web"
        sendText={vi.fn()}
        capabilityDisclosure={caps}
        workContext={{ status: 'quiet', summaries: [] }}
      />,
    );

    await screen.findByTestId('capsule-capability-more');
    expect(screen.queryByTestId('capsule-context-item-claude-code')).not.toBeInTheDocument();
    expect(screen.queryByTestId('capsule-context-disclosure')).not.toBeInTheDocument();
  });
});
