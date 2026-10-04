import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    // One selection path for every row, and it opens the detail (SC-20).
    expect(caps.onSelect).toHaveBeenCalledWith('claude-code');
  });

  it('keeps the sensed rows first and the ordinary ones in the same list (SC-35)', async () => {
    // The owner amended this criterion on 2026-10-04: there is no secondary
    // path and no `All capabilities` step, so every capability is one row away
    // in the list the user is already looking at. What survives from the
    // original wording is the ordering — sensed capability first, and the
    // catalog below it rather than above.
    const caps = disclosure();
    render(
      <TerminalCapsule experience="web" sendText={vi.fn()} capabilityDisclosure={caps} workContext={workContext()} />,
    );

    await userEvent.click(screen.getByTestId('capsule-capability-more'));

    const sensed = await screen.findByTestId('capsule-context-item-claude-code');
    const ordinary = screen.getByTestId('capsule-capability-picker-git');
    expect(screen.queryByTestId('capsule-context-all')).not.toBeInTheDocument();

    // Document order is what "first" means to a reader and to a screen reader
    // alike: `compareDocumentPosition` returns FOLLOWING when the second node
    // comes after the first.
    expect(sensed.compareDocumentPosition(ordinary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

    // …and it is selection, not decoration: the row selects through the same
    // path a work-sensed or ordinary row does (SC-38/SC-40).
    await userEvent.click(item);
    expect(caps.onSelect).toHaveBeenCalledWith('terminal-keys');
  });

  it('is the ordinary capability list when nothing is sensed', async () => {
    const caps = disclosure();
    render(<TerminalCapsule experience="web" sendText={vi.fn()} capabilityDisclosure={caps} />);

    await userEvent.click(screen.getByTestId('capsule-capability-more'));
    const git = await screen.findByTestId('capsule-capability-picker-git');
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

  it('adds a surface above the shell instead of replacing it (SC-41/SC-43)', async () => {
    const caps = disclosure();
    render(
      <TerminalCapsule experience="web" sendText={vi.fn()} capabilityDisclosure={caps} workContext={workContext()} />,
    );

    // The shape of the thing: a sibling inside the same dock, above the shell.
    const dock = screen.getByTestId('terminal-capsule');
    const shellBefore = screen.getByTestId('capsule-shell');
    // The shell's *own* description — the attributes that decide its box. Not
    // its subtree: the `+` inside it reports `aria-expanded`, and that is the
    // trigger telling the truth about the surface, not the shell moving.
    const boxOf = (el: HTMLElement) => ({
      className: el.className,
      dataset: { ...el.dataset },
      style: el.getAttribute('style'),
    });
    const shellBox = boxOf(shellBefore);

    await userEvent.click(screen.getByTestId('capsule-capability-more'));

    const surface = await screen.findByTestId('capsule-context-disclosure');
    expect(dock.contains(surface)).toBe(true);
    // Above, not replacing: the shell element is the same node with the same
    // box, and the surface precedes it in document order — which is what puts it
    // on top in a bottom-anchored `flex-col` dock.
    expect(screen.getByTestId('capsule-shell')).toBe(shellBefore);
    expect(
      surface.compareDocumentPosition(shellBefore) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(boxOf(shellBefore)).toEqual(shellBox);
    // …and the trigger knows the surface is up.
    expect(screen.getByTestId('capsule-capability-more')).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps the shell in place when a row deepens the surface to a Peek (SC-43)', async () => {
    const caps = disclosure();
    const projection: CapsuleCapabilityProjection = {
      id: 'claude-code',
      title: 'Claude Code',
      depth: 'peek',
      body: () => <p data-testid="projection-body">peek</p>,
      onDismiss: vi.fn(),
    };
    const { rerender } = render(
      <TerminalCapsule experience="web" sendText={vi.fn()} capabilityDisclosure={caps} workContext={workContext()} />,
    );

    await userEvent.click(screen.getByTestId('capsule-capability-more'));
    await userEvent.click(await screen.findByTestId('capsule-context-item-claude-code'));

    // The row was dispatched (existing cases assert which callback), and the
    // lower Capsule is still the anchor: the Peek takes the *upper* slot, so
    // the shell that was there before the row is the shell that is there after.
    const shellAfter = screen.getByTestId('capsule-shell');
    rerender(
      <TerminalCapsule
        experience="web"
        sendText={vi.fn()}
        capabilityDisclosure={caps}
        capabilityProjection={projection}
        workContext={workContext()}
      />,
    );
    expect(screen.getByTestId('capsule-capability-projection')).toBeInTheDocument();
    expect(screen.getByTestId('capsule-shell')).toBe(shellAfter);
    // …and the list is gone, because the two are one slot rather than a stack.
    expect(screen.queryByTestId('capsule-context-disclosure')).not.toBeInTheDocument();
  });

  it('closes on the trigger again, and on a pointer outside (#1347 SC-43)', async () => {
    const caps = disclosure();
    render(
      <TerminalCapsule experience="web" sendText={vi.fn()} capabilityDisclosure={caps} workContext={workContext()} />,
    );

    // The trigger toggles. This is worth asserting rather than assuming: the
    // outside-pointerdismissal listens on `document`, so without the guard that
    // ignores a pointer landing on the trigger, one tap would dismiss on
    // pointerdown and toggle on click — closing it twice and reopening it once.
    const trigger = screen.getByTestId('capsule-capability-more');
    await userEvent.click(trigger);
    expect(await screen.findByTestId('capsule-context-disclosure')).toBeInTheDocument();
    await userEvent.click(trigger);
    expect(screen.queryByTestId('capsule-context-disclosure')).not.toBeInTheDocument();

    // …and a pointer anywhere else closes it, because nothing else would: this
    // surface is not a popup, so no primitive dismisses it for us.
    await userEvent.click(trigger);
    expect(await screen.findByTestId('capsule-context-disclosure')).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('capsule-context-disclosure')).not.toBeInTheDocument();
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

    // The surface is gone, and that is now the whole assertion: it is an
    // in-flow sibling of the shell, not a portalled popup, so there is no exit
    // transition leaving a `data-closed` node behind for the assertion to
    // mistake for "still open".
    await waitFor(() => {
      expect(screen.queryByTestId('capsule-context-disclosure')).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId('capsule-context-item-claude-code')).not.toBeInTheDocument();
  });

  // The focus contract of the approved interaction, and the one thing the menu
  // primitive used to provide for free. A keyboard user who opens this list and
  // changes their mind must not be dropped at the top of the document with
  // their place gone.
  //
  // One case per way out, rather than a loop with one assertion: they are four
  // different code paths that only happen to converge, and a loop reports the
  // first one it breaks on and silently skips the rest.
  describe.each([
    ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
    ['a pointer outside', () => fireEvent.pointerDown(document.body)],
    // `fireEvent`, not `userEvent`: a user-level click focuses the button it
    // clicks, so it would leave focus on the trigger and this case would pass
    // whether or not the surface restores anything. The real sequence is the
    // surface's own focus-in (focus is on a row), then the tap — which is what
    // `fireEvent` reproduces, and the only version of this that can fail.
    ['the trigger again', () => fireEvent.click(screen.getByTestId('capsule-capability-more'))],
  ])('dismissed by %s', (_name, dismiss) => {
    it('hands focus back to the trigger, not to the body', async () => {
      render(
        <TerminalCapsule
          experience="web"
          sendText={vi.fn()}
          capabilityDisclosure={disclosure()}
          workContext={workContext()}
        />,
      );

      const trigger = screen.getByTestId('capsule-capability-more');
      await userEvent.click(trigger);
      // Focus really does enter the surface, so this is about where it lands on
      // the way out and not about a surface that never had it.
      expect(await screen.findByTestId('capsule-context-item-claude-code')).toHaveFocus();

      await dismiss();

      await waitFor(() => {
        expect(screen.queryByTestId('capsule-context-disclosure')).not.toBeInTheDocument();
      });
      expect(trigger).toHaveFocus();
    });
  });

  it('hands focus back to the trigger when a row deepens the surface into a Peek', async () => {
    // The same loss on the one dismissal a user is most likely to perform.
    render(
      <TerminalCapsule
        experience="web"
        sendText={vi.fn()}
        capabilityDisclosure={disclosure()}
        workContext={workContext()}
      />,
    );

    const trigger = screen.getByTestId('capsule-capability-more');
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByTestId('capsule-capability-picker-git'));

    expect(screen.queryByTestId('capsule-context-disclosure')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('leaves focus alone when a sense ends under a user who has moved on (SC-36)', async () => {
    // The guard, and the reason this is not simply "restore on unmount": a
    // sense can end while the user is typing in the composer, which unmounts
    // the same component. Focus belongs where the user put it.
    const caps = disclosure();
    const { rerender } = render(
      <TerminalCapsule experience="web" sendText={vi.fn()} capabilityDisclosure={caps} workContext={workContext()} />,
    );

    await userEvent.click(screen.getByTestId('capsule-capability-more'));
    await screen.findByTestId('capsule-context-item-claude-code');

    // The user has moved on: the composer holds focus.
    const field = screen.getByTestId('capsule-ghost-input');
    field.focus();
    expect(field).toHaveFocus();

    rerender(
      <TerminalCapsule
        experience="web"
        sendText={vi.fn()}
        capabilityDisclosure={caps}
        workContext={{ status: 'quiet', summaries: [] }}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByTestId('capsule-context-disclosure')).not.toBeInTheDocument();
    });
    expect(field).toHaveFocus();
  });
});
