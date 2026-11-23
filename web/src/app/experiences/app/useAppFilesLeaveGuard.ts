import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileRef } from '@/capabilities/files';
import type { WorkspaceDepthControl } from '@/app/workspace/workspaceContext';

export interface AppFilesSelection {
  ref: FileRef;
  path: string;
  filename: string;
  size: number;
  initialLine?: number;
  initialColumn?: number;
}

/**
 * Files' one guarded leave and its forward record (#3971).
 *
 * Leaving the viewer runs the guard the state protects; only an accepted leave
 * records the file as the forward destination a leftward inner swipe may
 * re-open. A cancelled leave never becomes a gesture target, and any new
 * navigation clears it. The shell owns the gesture; this owns the destination
 * and the guard, so the two can never disagree about unsaved work.
 */
export function useAppFilesLeaveGuard({
  depth,
  selected,
  setSelected,
  dirty,
  setDirty,
  setShowDiscardDialog,
}: {
  depth: WorkspaceDepthControl;
  selected: AppFilesSelection | null;
  setSelected: (value: AppFilesSelection | null) => void;
  dirty: boolean;
  setDirty: (dirty: boolean) => void;
  setShowDiscardDialog: (open: boolean) => void;
}) {
  const [forwardFile, setForwardFile] = useState<AppFilesSelection | null>(null);
  const pendingLeaveRef = useRef<(() => void) | null>(null);

  const leaveSelection = useCallback(() => {
    if (selected !== null) {
      setForwardFile(selected);
    }
    setSelected(null);
  }, [selected, setSelected]);

  const requestLeave = useCallback(
    (after?: () => void) => {
      if (dirty) {
        pendingLeaveRef.current = after ?? null;
        setShowDiscardDialog(true);
        return;
      }
      leaveSelection();
      after?.();
    },
    [dirty, leaveSelection, setShowDiscardDialog],
  );

  const confirmDiscard = useCallback(() => {
    setShowDiscardDialog(false);
    leaveSelection();
    const after = pendingLeaveRef.current;
    pendingLeaveRef.current = null;
    after?.();
  }, [leaveSelection, setShowDiscardDialog]);

  const clearForward = useCallback(() => setForwardFile(null), []);

  const activateForward = useCallback(() => {
    if (forwardFile === null) {
      return;
    }
    setForwardFile(null);
    setDirty(false);
    setShowDiscardDialog(false);
    setSelected(forwardFile);
  }, [forwardFile, setDirty, setSelected, setShowDiscardDialog]);

  const setForward = depth.setForward;
  useEffect(() => {
    if (setForward === undefined) {
      return;
    }
    setForward(forwardFile === null
      ? null
      : { title: forwardFile.filename, onActivate: activateForward });
  }, [activateForward, forwardFile, setForward]);
  useEffect(
    () => () => setForward?.(null),
    [setForward],
  );

  return { requestLeave, confirmDiscard, clearForward };
}
