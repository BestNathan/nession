import { useCallback, useEffect, useState } from 'react';
import type { SpatialPageIndex } from '@/session-first/app-spatial/AppSpatialShell';
import type { Surface } from '@/session-first/patterns/SessionHeader';
import type { Session } from '@/types';

/** Pager index + surface sync for mobile AppSpatialShell. */
export function useAppSpatialIndex(opts: {
  selectedId: string | null;
  surface: Surface;
  active: boolean;
  onSurfaceChange: (surface: Surface) => void;
  onSelect: (session: Session) => void;
}) {
  const { selectedId, surface, active, onSurfaceChange, onSelect } = opts;
  const [spatialIndex, setSpatialIndex] = useState<SpatialPageIndex>(1);

  // Reset to Terminal page whenever a session becomes selected (or selection changes).
  useEffect(() => {
    if (selectedId) {
      setSpatialIndex(1);
    }
  }, [selectedId]);

  // Parent surface drives pager index while spatial; never yank off Sessions (index 0)
  // when surface is terminal.
  useEffect(() => {
    if (!active) {
      return;
    }
    if (surface === 'workspace') {
      setSpatialIndex(2);
    } else if (surface === 'terminal') {
      setSpatialIndex((index) => (index === 2 ? 1 : index));
    }
  }, [surface, active]);

  const onIndexChange = useCallback(
    (index: SpatialPageIndex) => {
      setSpatialIndex(index);
      if (index === 2) {
        onSurfaceChange('workspace');
      } else if (index === 1) {
        onSurfaceChange('terminal');
      }
    },
    [onSurfaceChange],
  );

  const onSpatialSelect = useCallback(
    (session: Session) => {
      onSelect(session);
      setSpatialIndex(1);
    },
    [onSelect],
  );

  return { spatialIndex, onIndexChange, onSpatialSelect };
}
