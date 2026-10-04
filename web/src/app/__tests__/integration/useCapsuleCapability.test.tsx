import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Keyboard } from 'lucide-react';
import { useCapsuleCapability } from '@/app/useCapsuleCapability';
import { TerminalCapsule } from '@/product/terminal/capsule/TerminalCapsule';
import type { CapabilityId } from '@/product/capability';
import type { Session } from '@/types';

vi.mock('@/product/terminal/hooks/useCommandHistory', () => ({
  useCommandHistory: () => ({
    addEntry: vi.fn(),
    history: [],
    removeEntry: vi.fn(),
    clearHistory: vi.fn(),
    filterHistory: vi.fn().mockReturnValue([]),
  }),
}));

function session(id: string, foregroundCommand: string | null = null): Session {
  return {
    session_id: id,
    session_name: id,
    agent_id: 'a1',
    foreground_command: foregroundCommand,
  } as Session;
}

function setup(overrides: { session?: Session | null; experience?: 'web' | 'app' } = {}) {
  const onToolChange = vi.fn();
  const onSurfaceChange = vi.fn();
  const onOpenWorkspace = vi.fn();
  const initialProps = {
    session: overrides.session === undefined ? session('s1') : overrides.session,
    agent: { agent_id: 'a1' } as never,
    agents: [],
    domain: null,
    fileOps: {} as never,
    experience: overrides.experience ?? ('web' as const),
    onToolChange,
    onSurfaceChange,
    onOpenWorkspace,
  };

  const view = renderHook(
    (props: typeof initialProps) => useCapsuleCapability(props),
    { initialProps },
  );

  const choose = (id: CapabilityId) =>
    act(() => {
      view.result.current.capabilities.disclosure?.onSelect(id);
    });

  const dismiss = () =>
    act(() => {
      view.result.current.projection?.onDismiss();
    });

  return { ...view, initialProps, choose, dismiss, onToolChange, onSurfaceChange, onOpenWorkspace };
}

describe('capsule emergence', () => {
  it('is dormant until something is chosen', () => {
    const { result } = setup();

    expect(result.current.projection).toBeUndefined();
  });

  it('shows the capability the user chose', () => {
    const { result, choose } = setup();

    choose('git');

    expect(result.current.projection?.id).toBe('git');
  });

  it('titles the projection from the capability, not from the view', () => {
    const { result, choose } = setup();

    choose('git');

    expect(result.current.projection?.title).toBe('Git');
  });

  it('dismissing closes the projection', () => {
    // One dismissal, not two. Stepping Peek -> Signal -> Dormant was the walk
    // a two-depth model produced, and the Signal it landed on was a state the
    // user never asked for.
    const { result, choose, dismiss } = setup();

    choose('git');
    expect(result.current.projection?.id).toBe('git');

    dismiss();
    expect(result.current.projection).toBeUndefined();
  });

  it('does not emerge on its own for work the capsule already senses (SC-34)', () => {
    // The owner's 2026-10-03 decision, and a reversal of what this test used to
    // assert: a pane running `claude.exe` lights the *Work Ring* — that is the
    // ambient representation — and the observed-command path must stand down,
    // or one fact arrives three times (auto Signal, ring, disclosure).
    const { result, choose, onSurfaceChange } = setup({
      session: session('s1', 'claude.exe'),
    });

    expect(result.current.projection).toBeUndefined();

    // …and the user's own move still deepens it: choosing the sensed row in
    // the Context Disclosure opens the projection (SC-20).
    choose('claude-code');

    expect(result.current.projection?.id).toBe('claude-code');
    // Deepening is not opening the surface: the work surface is not taken.
    expect(onSurfaceChange).not.toHaveBeenCalled();
  });

  it('opens Terminal Keys like any other capability (SC-38)', () => {
    // This test has asserted several shapes. It first asserted the opposite —
    // the accessory had no deeper step because it *was* its own body. The
    // 2026-10-03 review retired that family (SC-38): Terminal Keys opens like
    // any other capability. It then walked the ordinary Signal -> title ->
    // Peek steps, which are gone too — choosing is the whole protocol now, for
    // every capability alike.
    const { result, choose } = setup();

    choose('terminal-keys');

    expect(result.current.projection?.id).toBe('terminal-keys');
    // No Workspace view, so no destination is offered from here — the shape
    // SC-38 kept, expressed by the capability having no view binding.
    expect(result.current.projection?.onOpenWorkspace).toBeUndefined();
  });

  it('senses Terminal Keys by context on App, and only there (SC-37)', () => {
    // Context sense, not work sense: the disclosure lists it because the device
    // has no keyboard. It must not need — or set — any work signal, and Web
    // (a physical keyboard) must not sense it at all.
    const app = setup({ experience: 'app' });
    expect(app.result.current.capabilities.disclosure?.sensedContext).toEqual([
      {
        capabilityId: 'terminal-keys',
        title: 'Terminal Keys',
        icon: Keyboard,
        reason: 'Touch controls for Terminal',
      },
    ]);

    const web = setup({ experience: 'web' });
    expect(web.result.current.capabilities.disclosure?.sensedContext).toEqual([]);
  });

  it('draws the context-sensed row with its glyph, not an empty column (SC-37)', async () => {
    // The seam this closes. `sensedWorkItems` copied the entry's icon;
    // `resolveSensedContext` did not, and the capsule reserves a 16px icon
    // column on every row — so on App, where the context sense actually fires
    // (Web has a physical keyboard and never senses it), its row drew an empty
    // slot where the other rows drew identity.
    //
    // The disclosure is the one the real hook resolved, not a hand-built
    // fixture: the glyph has to arrive *through* `resolveSensedContext`, and a
    // fixture carrying its own icon would pass with the seam still open.
    // Mutation: drop `icon: entry.icon` from `resolveSensedContext` — must fail.
    const app = setup({ experience: 'app' });
    render(
      <TerminalCapsule
        experience="app"
        sendText={vi.fn()}
        capabilityDisclosure={app.result.current.capabilities.disclosure}
      />,
    );

    await userEvent.click(screen.getByTestId('capsule-capability-more'));

    const row = await screen.findByTestId('capsule-context-item-terminal-keys');
    expect(row.querySelector('svg')).not.toBeNull();
  });

  it('carries the capability’s own answer about the soft keyboard', () => {
    // #1034 §5. Terminal Keys and an IME want the same vertical space, so that
    // projection claims input focus while it is up; Git's projection is read
    // *while* typing (`git commit`), so taking the keyboard from it would be
    // the regression, not the fix.
    //
    // This asymmetry is the design, and the capsule has no capability ids — so
    // this flag is the entire mechanism by which the two are told apart, and it
    // has to arrive on the resolved projection for any of it to work.
    const { result, choose } = setup();

    choose('terminal-keys');
    expect(result.current.projection?.id).toBe('terminal-keys');
    expect(result.current.projection?.ownsInputFocus).toBe(true);

    choose('git');
    expect(result.current.projection?.id).toBe('git');
    expect(result.current.projection?.ownsInputFocus).toBeFalsy();
  });

  it('never changes surface when a capability is chosen', () => {
    // **The inversion (#1046).** This test used to assert the opposite — that
    // choosing a capability with no Terminal depth fell through to
    // `onToolChange` + `onSurfaceChange`, i.e. that the capsule entry was a
    // shortcut into the Workspace. Removing that is the point of the
    // requirement: selecting a capsule item must leave the user where they are.
    //
    // Asserted with a listed capability *and* an unlisted one, because the two
    // fail independently. The listed one proves the rule on the path the entry
    // can actually reach; the unlisted one proves the entry cannot reach it —
    // if `files` ever switches surface again, the capsule has become a launcher
    // again, whether or not the eligible path still behaves.
    const { result, choose, onToolChange, onSurfaceChange } = setup();

    // An unlisted capability. The entry cannot offer it — that is the previous
    // test — but choosing it must still not open the Workspace: it has nothing
    // to emerge, so the honest outcome is that nothing happens at all.
    choose('files');
    expect(onToolChange).not.toHaveBeenCalled();
    expect(onSurfaceChange).not.toHaveBeenCalled();
    expect(result.current.projection).toBeUndefined();

    // A listed one, so the assertions above are not passing because `choose`
    // does nothing at all.
    choose('git');
    expect(onToolChange).not.toHaveBeenCalled();
    expect(onSurfaceChange).not.toHaveBeenCalled();
    expect(result.current.projection?.id).toBe('git');
  });

  it('does not re-show what was dismissed', () => {
    // #1165 recorded a ✕ that fired and was undone in the same frame. The
    // observed-command path that caused it is gone, so the guard is the
    // simpler one now: dismissing clears the choice and nothing puts it back.
    // Mutation: leave `chosen` set in `onDismiss` — this must fail.
    const { result, choose, dismiss } = setup();

    choose('git');
    dismiss();

    expect(result.current.projection).toBeUndefined();
  });

  it('carries the focused item into the Workspace', () => {
    const { result, choose, onOpenWorkspace } = setup();

    choose('git');
    // Git has a Workspace view, so the destination exists — a projection with
    // no Workspace view would carry nothing, and this is where that would show.
    expect(result.current.projection?.onOpenWorkspace).toBeTypeOf('function');
    act(() => result.current.projection?.onOpenWorkspace?.('src/a.ts'));

    // #826: entering from a projection lands on the item, not on a landing page.
    expect(onOpenWorkspace).toHaveBeenCalledWith('git', 'src/a.ts');
  });

  it('supplies no Workspace destination for a capability with no Workspace view', () => {
    // Presence is the app layer's answer — the Workspace view registry — so a
    // capability without a view (Terminal Keys) gets no routing at all, and the
    // host's footer is what stays undrawn (#1347 SC-21).
    const { result, choose } = setup();

    choose('terminal-keys');

    expect(result.current.projection?.id).toBe('terminal-keys');
    expect(result.current.projection?.onOpenWorkspace).toBeUndefined();
  });

  it('returns to dormant when the Session changes', () => {
    // Q1's decay, and the edge case the requirement names: a projection belongs
    // to the Session that produced it.
    const { result, choose, rerender, initialProps } = setup();

    choose('git');
    expect(result.current.projection).toBeDefined();

    rerender({ ...initialProps, session: session('s2') });

    expect(result.current.projection).toBeUndefined();
  });
});
