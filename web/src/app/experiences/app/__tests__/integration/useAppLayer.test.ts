import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Surface } from '@/app/patterns/SessionHeader';
import { useAppLayer } from '../../useAppLayer';

interface SetupArgs {
  selectedId: string | null;
  surface: Surface;
  active: boolean;
}

function setup(overrides: Partial<SetupArgs> = {}) {
  const { selectedId = 'a1:fix', surface = 'terminal', active = true } = overrides;
  const onSurfaceChange = vi.fn();
  const onSelect = vi.fn();
  const { result, rerender } = renderHook(
    (props: { selectedId: string | null; surface: Surface; active: boolean }) =>
      useAppLayer({ ...props, onSurfaceChange, onSelect }),
    { initialProps: { selectedId, surface, active } },
  );
  return { result, rerender, onSurfaceChange, onSelect };
}

describe('useAppLayer — the Workspace layer needs a Session (#1082)', () => {
  it('reports Workspace as unavailable exactly when nothing is selected', () => {
    const without = setup({ selectedId: null });
    expect(without.result.current.workspaceAvailable).toBe(false);

    const withSession = setup({ selectedId: 'a1:fix' });
    expect(withSession.result.current.workspaceAvailable).toBe(true);
  });

  it('stays on the Terminal root when there is no Session, whatever surface says', () => {
    // The App composition now exists before a Session does, so this hook is
    // reached with `selectedId === null` — and a `surface` of 'workspace' can
    // outlive the Session that justified it. Opening the layer there would
    // paint an empty depth over the home.
    const { result, rerender } = setup({ selectedId: null, surface: 'terminal' });
    expect(result.current.layer).toBe('terminal');

    rerender({ selectedId: null, surface: 'workspace', active: true });
    expect(result.current.layer).toBe('terminal');
  });

  it('leaves the Workspace layer when the Session goes away', () => {
    const { result, rerender } = setup({ selectedId: 'a1:fix', surface: 'workspace' });
    expect(result.current.layer).toBe('workspace');

    // Killed: the selection clears, `surface` stays where it was.
    rerender({ selectedId: null, surface: 'workspace', active: true });

    expect(result.current.layer).toBe('terminal');
    expect(result.current.workspaceAvailable).toBe(false);
  });

  it('still opens the Workspace layer for a selected Session', () => {
    const { result, rerender } = setup({ selectedId: 'a1:fix', surface: 'terminal' });
    expect(result.current.layer).toBe('terminal');

    rerender({ selectedId: 'a1:fix', surface: 'workspace', active: true });

    expect(result.current.layer).toBe('workspace');
  });

  it('does not close the Sessions layer when the surface changes underneath it', () => {
    // Carried from #1049 and still true: a capability can change surface while
    // Sessions is open, and the effect that follows it must not yank the user
    // back to the Terminal. Only Workspace claims the layer outright.
    const { result, rerender } = setup({ selectedId: 'a1:fix', surface: 'terminal' });
    act(() => {
      result.current.onLayerChange('sessions');
    });
    expect(result.current.layer).toBe('sessions');

    rerender({ selectedId: 'a1:fix', surface: 'terminal', active: true });

    expect(result.current.layer).toBe('sessions');
  });
});
