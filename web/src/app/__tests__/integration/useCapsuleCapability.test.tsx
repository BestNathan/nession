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

function setup(overrides: { session?: Session | null } = {}) {
  const onToolChange = vi.fn();
  const onSurfaceChange = vi.fn();
  const onOpenWorkspace = vi.fn();
  const initialProps = {
    session: overrides.session === undefined ? session('s1') : overrides.session,
    agent: { agent_id: 'a1' } as never,
    agents: [],
    domain: null,
    fileOps: {} as never,
    experience: 'web' as const,
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

  return { ...view, initialProps, choose, onToolChange, onSurfaceChange, onOpenWorkspace };
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

  it('opens the Signal to a Peek, one level at a time', () => {
    const { result, choose } = setup();

    choose('git');
    act(() => result.current.projection?.onDeeper());

    expect(result.current.projection?.depth).toBe('peek');
  });

  it('closes a Peek back to the Signal it came from', () => {
    // Closing a detail view should not also destroy the indication that made it
    // worth opening.
    const { result, choose } = setup();

    choose('git');
    act(() => result.current.projection?.onDeeper());
    act(() => result.current.projection?.onDismiss());

    expect(result.current.projection?.depth).toBe('signal');
  });

  it('closes the Signal to dormant', () => {
    const { result, choose } = setup();

    choose('git');
    act(() => result.current.projection?.onDismiss());

    expect(result.current.projection).toBeUndefined();
  });

  it('leaves an observed capability dormant while it has nothing to draw', () => {
    // The observed-command path is live and claude-code *is* `active` here, but
    // it has no Terminal projection yet, so nothing may emerge: selecting it
    // would pick a depth nothing renders and swallow the capability silently.
    // It stays reachable through the entry, which is what choosing it does.
    const { result, choose, onToolChange, onSurfaceChange } = setup({
      session: session('s1', 'claude.exe'),
    });

    expect(result.current.projection).toBeUndefined();
    expect(
      result.current.capabilities.disclosure?.entries.find((e) => e.id === 'claude-code')?.state,
    ).toBe('active');

    choose('claude-code');

    expect(result.current.projection).toBeUndefined();
    expect(onToolChange).toHaveBeenCalledWith('claude-code');
    expect(onSurfaceChange).toHaveBeenCalledTimes(1);
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

  it('hands a capability with no Terminal depth to the Workspace, as before', () => {
    // Files has no Signal to emerge; the entry keeps doing what it always did.
    const { result, choose, onToolChange, onSurfaceChange } = setup();

    choose('files');

    expect(onToolChange).toHaveBeenCalledWith('files');
    expect(onSurfaceChange).toHaveBeenCalledTimes(1);
    expect(result.current.projection).toBeUndefined();
  });

  it('carries the focused item into the Workspace', () => {
    const { result, choose, onOpenWorkspace } = setup();

    choose('git');
    act(() => result.current.projection?.onDeeper());
    // The capability has somewhere deeper to go — a projection with no
    // Workspace view would carry nothing, and this is where that would show.
    expect(result.current.projection?.onOpenWorkspace).toBeTypeOf('function');
    act(() => result.current.projection?.onOpenWorkspace?.('src/a.ts'));

    // #826: entering from a Peek lands on the item, not on a landing page.
    expect(onOpenWorkspace).toHaveBeenCalledWith('git', 'src/a.ts');
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
