import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileRef, FileSaveHandler } from '@/capabilities/files';

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

  const activate = useCallback((next: FilesWebSelection) => {
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
    if (!next && pendingRef.current !== null && !guardSaveRef.current) {
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

  const closeFile = useCallback(() => {
    dirtyRef.current = false;
    savingRef.current = false;
    setSaving(false);
    setSelected(null);
  }, []);

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
      if (outcome === 'saved') {
        commitPending();
      } else if (outcome === 'conflict') {
        // The viewer's conflict decision now owns the next step; keep A.
        clearPending();
      } else {
        setError('The file could not be saved. Your draft is still here.');
      }
    } finally {
      guardSaveRef.current = false;
      setGuardSaving(false);
    }
  }, [clearPending, commitPending, guardSaving]);

  useEffect(() => {
    setSelected(null);
    clearPending();
    dirtyRef.current = false;
    savingRef.current = false;
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
