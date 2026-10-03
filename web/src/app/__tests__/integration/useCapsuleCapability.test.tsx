import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useCapsuleCapability } from '@/app/useCapsuleCapability';
import type { CapabilityId } from '@/product/capability';
import type { Session } from '@/types';

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

  const chooseAtPeek = (id: CapabilityId) =>
    act(() => {
      view.result.current.capabilities.disclosure?.onSelectAtPeek?.(id);
    });

  return { ...view, initialProps, choose, chooseAtPeek, onToolChange, onSurfaceChange, onOpenWorkspace };
}

describe('capsule emergence', () => {
  it('is dormant until something is chosen', () => {
    const { result } = setup();

    expect(result.current.projection).toBeUndefined();
  });

  it('emerges a Signal for a capability that has a Terminal depth', () => {
    const { result, choose, onSurfaceChange } = setup();

    choose('git');

    expect(result.current.projection?.id).toBe('git');
    expect(result.current.projection?.depth).toBe('signal');
    // Choosing it must not steal the work surface — that is the whole point of
    // a Signal existing.
    expect(onSurfaceChange).not.toHaveBeenCalled();
  });

  it('titles the projection from the capability, not from the view', () => {
    const { result, choose } = setup();

    choose('git');

    expect(result.current.projection?.title).toBe('Git');
  });

  it('emerges a Peek directly when chosen at Peek depth (#1347 SC-20)', () => {
    // The Context Disclosure's sensed rows select through `onSelectAtPeek`: the capability is
    // already the subject of the surface the user is leaving, so skipping the
    // Signal it would otherwise open at is the point, not a shortcut.
    const { result, chooseAtPeek, onSurfaceChange } = setup();

    chooseAtPeek('git');

    expect(result.current.projection?.id).toBe('git');
    expect(result.current.projection?.depth).toBe('peek');
    // A Peek from the Work Overview still must not take the work surface.
    expect(onSurfaceChange).not.toHaveBeenCalled();
  });

  it('opens the Signal to a Peek, one level at a time', () => {
    const { result, choose } = setup();

    choose('git');
    act(() => result.current.projection?.onDeeper?.());

    expect(result.current.projection?.depth).toBe('peek');
  });

  it('closes a Peek back to the Signal it came from', () => {
    // Closing a detail view should not also destroy the indication that made it
    // worth opening.
    const { result, choose } = setup();

    choose('git');
    act(() => result.current.projection?.onDeeper?.());
    act(() => result.current.projection?.onDismiss());

    expect(result.current.projection?.depth).toBe('signal');
  });

  it('closes the Signal to dormant', () => {
    const { result, choose } = setup();

    choose('git');
    act(() => result.current.projection?.onDismiss());

    expect(result.current.projection).toBeUndefined();
  });

  it('does not emerge on its own for work the capsule already senses (SC-34)', () => {
    // The owner's 2026-10-03 decision, and a reversal of what this test used to
    // assert: a pane running `claude.exe` lights the *Work Ring* — that is the
    // ambient representation — and the observed-command path must stand down,
    // or one fact arrives three times (auto Signal, ring, disclosure).
    const { result, chooseAtPeek, onSurfaceChange } = setup({
      session: session('s1', 'claude.exe'),
    });

    expect(result.current.projection).toBeUndefined();

    // …and the user's own move still deepens it: choosing the sensed row in
    // the Context Disclosure opens the Peek directly (SC-20).
    chooseAtPeek('claude-code');

    expect(result.current.projection?.id).toBe('claude-code');
    expect(result.current.projection?.depth).toBe('peek');
    // Deepening is not opening the surface: the work surface is not taken.
    expect(onSurfaceChange).not.toHaveBeenCalled();
  });

  it('walks the ordinary Signal -> Peek protocol for Terminal Keys (SC-38)', () => {
    // This test used to assert the opposite — the accessory had no deeper step
    // because it *was* its own body. The 2026-10-03 review retired that family
    // (SC-38): Terminal Keys has a Peek like any other capability, so the
    // ordinary list opens its Signal and the title offers the step into it.
    const { result, choose } = setup();
    choose('terminal-keys');

    expect(result.current.projection?.id).toBe('terminal-keys');
    expect(result.current.projection?.depth).toBe('signal');

    act(() => result.current.projection?.onDeeper?.());

    expect(result.current.projection?.depth).toBe('peek');
  });

  it('senses Terminal Keys by context on App, and only there (SC-37)', () => {
    // Context sense, not work sense: the disclosure lists it because the device
    // has no keyboard. It must not need — or set — any work signal, and Web
    // (a physical keyboard) must not sense it at all.
    const app = setup({ experience: 'app' });
    expect(app.result.current.capabilities.disclosure?.sensedContext).toEqual([
      { capabilityId: 'terminal-keys', title: 'Terminal Keys', reason: 'Touch controls for Terminal' },
    ]);

    const web = setup({ experience: 'web' });
    expect(web.result.current.capabilities.disclosure?.sensedContext).toEqual([]);
  });

  it('carries the capability’s own answer about the soft keyboard', () => {
    // #1034 §5. Terminal Keys and an IME want the same vertical space, so that
    // projection claims input focus while it is up; Git's Signal and Peek are
    // read *while* typing (`git commit`), so taking the keyboard from them would
    // be the regression, not the fix.
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

  it('keeps a dismissed Signal dismissed', () => {
    // Without the dismissal being remembered, the next render would re-emerge
    // what the user just closed and the dismissal would undo itself.
    const { result, choose } = setup();

    choose('git');
    act(() => result.current.projection?.onDismiss());
    expect(result.current.projection).toBeUndefined();

    // And the entry is how it comes back — otherwise a closed Signal would be
    // unreachable until the Session changed.
    choose('git');
    expect(result.current.projection?.id).toBe('git');
  });

  it('carries the focused item into the Workspace', () => {
    const { result, choose, onOpenWorkspace } = setup();

    choose('git');
    act(() => result.current.projection?.onDeeper?.());
    // The capability has somewhere deeper to go — a projection with no
    // Workspace view would carry nothing, and this is where that would show.
    expect(result.current.projection?.onOpenWorkspace).toBeTypeOf('function');
    act(() => result.current.projection?.onOpenWorkspace?.('src/a.ts'));

    // #826: entering from a Peek lands on the item, not on a landing page.
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
