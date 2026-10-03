import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TerminalCapsule } from '@/product/terminal/capsule/TerminalCapsule';
import type {
  CapsuleCapabilityDisclosure,
  CapsuleCapabilityProjection,
} from '@/product/terminal/capsule/types';
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

  it('senses a context capability without lighting the Work Ring (SC-37)', async () => {
    // The ring answers `working`, and Terminal Keys is not working — it is
    // relevant because the device has no keyboard. So the same surface lists it
    // while the ring stays absent: the two senses share a protocol, not a
    // state. Rendered through the real capsule because the ring is the capsule's
    // (the disclosure itself never mentions one).
    const caps = disclosure({
      sensedContext: [
        {
          capabilityId: 'terminal-keys',
          title: 'Terminal Keys',
          reason: 'Touch controls for Terminal',
        },
      ],
    });
    render(
      <TerminalCapsule
        experience="app"
        sendText={vi.fn()}
        capabilityDisclosure={caps}
        workContext={{ status: 'quiet', summaries: [] }}
      />,
    );

    await userEvent.click(screen.getByTestId('capsule-capability-more'));

    const item = await screen.findByTestId('capsule-context-item-terminal-keys');
    expect(item).toHaveTextContent('Terminal Keys');
    expect(item).toHaveTextContent('Touch controls for Terminal');
    expect(screen.queryByTestId('work-ring')).not.toBeInTheDocument();

    // …and it is selection, not decoration: the row walks the same
    // sensed -> direct-Peek path a work-sensed row does (SC-38/SC-40).
    await userEvent.click(item);
    expect(caps.onSelectAtPeek).toHaveBeenCalledWith('terminal-keys');
    expect(caps.onSelect).not.toHaveBeenCalled();
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

  it('keeps an explicitly opened Peek when the sense disappears (SC-36)', async () => {
    // The other half of the lifecycle. Emergence itself is the hook's
    // (`useCapsuleCapability.test.tsx`); the claim here is that the capsule
    // does not take back a projection the user opened when the sense under it
    // goes away — the ring and the disclosure answer to sensing, a screen the
    // user asked for does not.
    const caps = disclosure();
    const projection: CapsuleCapabilityProjection = {
      id: 'claude-code',
      title: 'Claude Code',
      depth: 'peek',
      body: () => <p data-testid="projection-body">peek</p>,
      onDismiss: vi.fn(),
    };
    const { rerender } = render(
      <TerminalCapsule
        experience="web"
        sendText={vi.fn()}
        capabilityDisclosure={caps}
        capabilityProjection={projection}
        workContext={workContext()}
      />,
    );
    expect(screen.getByTestId('capsule-capability-projection')).toBeInTheDocument();

    rerender(
      <TerminalCapsule
        experience="web"
        sendText={vi.fn()}
        capabilityDisclosure={caps}
        capabilityProjection={projection}
        workContext={{ status: 'quiet', summaries: [] }}
      />,
    );

    expect(screen.getByTestId('capsule-capability-projection')).toBeInTheDocument();
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

    // The guarantee is that the surface closes, not that React has already torn
    // the portal down: base-ui keeps the popup mounted through its exit
    // transition and jsdom never runs that to completion, so "in the document"
    // reads the animation's last frame — which is why this passed locally and
    // failed on CI's timing. Absent, or present and already closed, both say
    // the thing the criterion says; the row above is the structural half.
    await waitFor(() => {
      const popup = screen.queryByTestId('capsule-context-disclosure');
      expect(popup === null || popup.hasAttribute('data-closed')).toBe(true);
    });
  });
});
