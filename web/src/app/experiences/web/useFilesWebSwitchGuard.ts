import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileRef, FileSaveHandler, FileSaveOutcome } from '@/capabilities/files';

export interface FilesWebSelection {
  ref: FileRef;
  filename: string;
  size: number;
  line?: number;
  column?: number;
}

export interface FilesWebSwitchState {
  pending: FilesWebSelection | null;
  saving: boolean;
  guardSaving: boolean;
  error: string | null;
  cancel: () => void;
  discard: () => void;
  save: () => Promise<void>;
}

function sameFile(a: FilesWebSelection | null, b: FilesWebSelection): boolean {
  return a !== null && a.ref.sourceId === b.ref.sourceId && a.ref.path === b.ref.path;
}

/**
 * Apply the viewer's guarded-save outcome to the pending decision (#3171,
 * #3959). Only a save that committed the current draft may open the target;
 * a successful write of an older snapshot while newer edits remain keeps A
 * and the one open decision, so a later save of the current draft or an
 * explicit discard is still required before the switch.
 */
function applyGuardedSaveOutcome(
  outcome: FileSaveOutcome,
  actions: {
    commitPending: () => void;
    clearPending: () => void;
    setError: (message: string) => void;
  },
): void {
  if (outcome === 'saved') {
    actions.commitPending();
  } else if (outcome === 'saved-dirty') {
    // Persisted, but not safe to navigate: keep A and the open decision.
  } else if (outcome === 'conflict') {
    // The viewer's conflict decision now owns the next step; keep A.
    actions.clearPending();
  } else {
    actions.setError('The file could not be saved. Your draft is still here.');
  }
}

/**
 * Web Files selection and its guarded transition.
 *
 * The mounted viewer owns content/dirty/revision/save; this hook owns *which*
 * file is selected and decides when a dirty document may be replaced. Refs are
 * the synchronous truth for the tree click path: a rapid second click can
 * arrive before React commits the previous dirty report, and reading state
 * alone would bypass the guard.
 */
export function useFilesWebSwitchGuard(resetKey: unknown) {
  const [selected, setSelected] = useState<FilesWebSelection | null>(null);
  const [pending, setPending] = useState<FilesWebSelection | null>(null);
  const [saving, setSaving] = useState(false); const [guardSaving, setGuardSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const pendingRef = useRef<FilesWebSelection | null>(null);
  const saveHandlerRef = useRef<FileSaveHandler | null>(null);
  const guardSaveRef = useRef(false);

  const clearPending = useCallback(() => {
    pendingRef.current = null;
    setPending(null);
    setError(null);
  }, []);

  /** Adopt a selection (or none), resetting the prior file's dirty/save state. */
  const activate = useCallback((next: FilesWebSelection | null) => {
    dirtyRef.current = false;
    savingRef.current = false;
    setSaving(false);
    setSelected(next);
  }, []);

  const commitPending = useCallback(() => {
    const target = pendingRef.current;
    clearPending();
    if (target) {
      activate(target);
    }
  }, [activate, clearPending]);

  const onDirtyChange = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);

  const onSavingChange = useCallback((next: boolean) => {
    savingRef.current = next;
    setSaving(next);
    if (next) {
      return;
    }
    if (guardSaveRef.current) {
      // This completion report belongs to the guard's own save, whose outcome
      // already decided the transition. Consume it without re-deciding: the
      // report can arrive after the save settled, and a newer draft must keep
      // the open decision rather than collect a stale failure message (#3959).
      guardSaveRef.current = false;
      return;
    }
    if (pendingRef.current !== null) {
      if (!dirtyRef.current) {
        commitPending();
      } else {
        setError('The save did not complete. Your draft is still here.');
      }
    }
  }, [commitPending]);

  const onSaveHandlerChange = useCallback((handler: FileSaveHandler | null) => {
    saveHandlerRef.current = handler;
  }, []);

  const requestFile = useCallback((next: FilesWebSelection): boolean => {
    if (sameFile(selected, next)) {
      return true;
    }
    if (!dirtyRef.current) {
      activate(next);
      return true;
    }
    if (pendingRef.current !== null) {
      return false;
    }
    pendingRef.current = next;
    setPending(next);
    setError(null);
    return false;
  }, [activate, selected]);

  const closeFile = useCallback(() => activate(null), [activate]);

  const cancel = useCallback(() => {
    if (!guardSaving) {
      clearPending();
    }
  }, [clearPending, guardSaving]);

  const discard = useCallback(() => {
    if (!guardSaving && !savingRef.current) {
      commitPending();
    }
  }, [commitPending, guardSaving]);

  const save = useCallback(async () => {
    if (guardSaving || savingRef.current) {
      return;
    }
    const handler = saveHandlerRef.current;
    if (!handler) {
      setError('This file cannot be saved right now. Keep editing or discard the draft.');
      return;
    }
    guardSaveRef.current = true;
    setGuardSaving(true);
    setError(null);
    try {
      const outcome = await handler();
      applyGuardedSaveOutcome(outcome, { commitPending, clearPending, setError });
    } finally {
      setGuardSaving(false);
      // The viewer's completion report usually arrives after this continuation
      // and consumes the ref itself. If it already ran (or the handler never
      // reports), nothing is left to consume, so close the window here.
      if (!savingRef.current) {
        guardSaveRef.current = false;
      }
    }
  }, [clearPending, commitPending, guardSaving]);

  useEffect(() => {
    setSelected(null);
    clearPending();
    dirtyRef.current = false;
    savingRef.current = false;
    guardSaveRef.current = false;
    setSaving(false);
  }, [resetKey, clearPending]);

  return {
    selected,
    requestFile,
    closeFile,
    onDirtyChange,
    onSavingChange,
    onSaveHandlerChange,
    switchState: { pending, saving, guardSaving, error, cancel, discard, save },
  };
}
