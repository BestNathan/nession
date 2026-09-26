import { useCallback, useEffect, useState } from 'react';
import type { AppLayer } from './appLayerPositions';
import type { Surface } from '@/app/patterns/SessionHeader';
import type { Session } from '@/types';

interface UseAppLayerArgs {
  selectedId: string | null;
  surface: Surface;
  /** False on the wide layout, where this hook's state is inert. */
  active: boolean;
  onSurfaceChange: (surface: Surface) => void;
  onSelect: (session: Session) => void;
}

/**
 * Which layer sits over the Terminal root (#1049 stage 2, #1082).
 *
 * This replaces `useAppSpatialIndex`. The pager index and `surface` were two
 * representations of one fact that an effect had to keep in step; a layer *is*
 * that fact, so the sync effect is gone rather than ported.
 *
 * Two rules carried over deliberately, both of them tested before and both
 * load-bearing:
 *
 * 1. **The Sessions layer is not a surface.** Opening it leaves `surface` at
 *    `terminal`, so the Terminal stays the surface underneath. That is the
 *    behaviour `FixtureApp.test.tsx` documents as "a pager position, not a
 *    surface" — the overlay model preserves the intent the pager had.
 * 2. **Selecting a Session returns to the Terminal root.**
 *
 * #1082 adds the case neither rule covered: **the App composition now exists
 * before a Session does**, so this hook is reached with `selectedId === null`.
 * Workspace is Session-scoped — it is the depth *around* a piece of work — so
 * with no work there is nothing for it to show. `workspaceAvailable` is that
 * fact, and it is returned rather than recomputed by the caller so the layer
 * state and the rendered layers cannot disagree about it.
 */
export function useAppLayer({
  selectedId,
  surface,
  active,
  onSurfaceChange,
  onSelect,
}: UseAppLayerArgs) {
  const [layer, setLayer] = useState<AppLayer>('terminal');

  const workspaceAvailable = selectedId !== null;

  useEffect(() => {
    if (selectedId) {
      setLayer('terminal');
    }
  }, [selectedId]);

  useEffect(() => {
    if (!active) {
      return;
    }
    if (!workspaceAvailable) {
      // `surface` outlives the Session that justified it: killing the selected
      // Session clears the selection but leaves `surface` where it was, so
      // without this the home would be painted under an empty Workspace depth.
      setLayer((current) => (current === 'workspace' ? 'terminal' : current));
      return;
    }
    if (surface === 'workspace') {
      setLayer('workspace');
      return;
    }
    // Leaving the workspace closes its layer, but must not yank the user out
    // of Sessions — a capability can change surface while Sessions is open.
    setLayer((current) => (current === 'workspace' ? 'terminal' : current));
  }, [active, surface, workspaceAvailable]);

  const onLayerChange = useCallback(
    (next: AppLayer) => {
      setLayer(next);
      if (next === 'workspace') {
        onSurfaceChange('workspace');
      } else if (next === 'terminal') {
        onSurfaceChange('terminal');
      }
    },
    [onSurfaceChange],
  );

  const onLayerSelect = useCallback(
    (session: Session) => {
      onSelect(session);
      setLayer('terminal');
    },
    [onSelect],
  );

  return { layer, onLayerChange, onLayerSelect, workspaceAvailable };
}
